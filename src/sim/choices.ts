import type { Sim } from './sim';
import type { BoonId, Choice, Pending } from './types';
import {
  PACT_IDS, EVOLVED_LEVEL, MAX_PASSIVES, MAX_WEAPONS, MAX_WEAPON_LEVEL, PASSIVES, PASSIVE_IDS, RELIC_IDS, WEAPONS, WEAPON_IDS,
} from './defs';

interface Weighted {
  c: Choice;
  w: number;
}

export function choiceKey(c: Choice): string {
  switch (c.type) {
    case 'weapon': return 'w:' + c.id;
    case 'evolve': return 'w:' + c.id;
    case 'passive': return 'p:' + c.id;
    case 'relic': return 'r:' + c.id;
    default: return c.type;
  }
}

/** every upgrade the player could currently take */
function pool(sim: Sim): Weighted[] {
  const p = sim.player;
  const out: Weighted[] = [];
  for (const id of WEAPON_IDS) {
    if (sim.banished.has('w:' + id)) continue;
    const w = sim.weapon(id);
    if (w) {
      if (w.level < MAX_WEAPON_LEVEL) out.push({ c: { type: 'weapon', id, level: w.level + 1, isNew: false }, w: 1.5 });
      else if (w.level === MAX_WEAPON_LEVEL && sim.passiveLevel(WEAPONS[id].evo) > 0) out.push({ c: { type: 'evolve', id }, w: 6 });
    } else if (p.weapons.length < MAX_WEAPONS) out.push({ c: { type: 'weapon', id, level: 1, isNew: true }, w: 1 });
  }
  for (const id of PASSIVE_IDS) {
    if (sim.banished.has('p:' + id)) continue;
    const lvl = sim.passiveLevel(id);
    if (lvl > 0) {
      if (lvl < PASSIVES[id].max) out.push({ c: { type: 'passive', id, level: lvl + 1, isNew: false }, w: 1.3 });
    } else if (p.passives.length < MAX_PASSIVES) {
      // nudge toward passives that unlock an evolution for an owned weapon
      let w = 1;
      for (const wi of p.weapons) if (WEAPONS[wi.id].evo === id) w = 1.6;
      out.push({ c: { type: 'passive', id, level: 1, isNew: true }, w });
    }
  }
  return out;
}

function draw(sim: Sim, list: Weighted[], n: number): Choice[] {
  const out: Choice[] = [];
  const src = list.slice();
  while (out.length < n && src.length > 0) {
    let total = 0;
    for (const s of src) total += s.w;
    let r = sim.rng.next() * total;
    let idx = 0;
    for (let i = 0; i < src.length; i++) {
      r -= src[i].w;
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    out.push(src[idx].c);
    src.splice(idx, 1);
  }
  return out;
}

export function rollLevelChoices(sim: Sim): Choice[] {
  const n = sim.rng.next() < (sim.player.st.luck - 1) * 0.5 ? 4 : 3;
  const c = draw(sim, pool(sim), n);
  if (c.length === 0) return [{ type: 'heal' }, { type: 'cinder' }];
  return c;
}

export function makeLevelPending(sim: Sim): Pending {
  return { type: 'levelup', choices: rollLevelChoices(sim) };
}

export function makeRelicPending(sim: Sim): Pending | null {
  const avail = RELIC_IDS.filter((r) => !sim.hasRelic(r) && !sim.banished.has('r:' + r));
  if (avail.length === 0) return null;
  sim.rng.shuffle(avail);
  return { type: 'relic', choices: avail.slice(0, 3).map((id) => ({ type: 'relic', id }) as Choice) };
}

export function applyChoice(sim: Sim, c: Choice) {
  const p = sim.player;
  switch (c.type) {
    case 'weapon': {
      const w = sim.weapon(c.id);
      if (w) w.level = Math.min(MAX_WEAPON_LEVEL, w.level + 1);
      else if (p.weapons.length < MAX_WEAPONS) p.weapons.push({ id: c.id, level: 1, t: 0.3, a: 0, b: 0, dealt: 0 });
      break;
    }
    case 'evolve': {
      const w = sim.weapon(c.id);
      if (w) w.level = EVOLVED_LEVEL;
      break;
    }
    case 'passive': {
      const ex = p.passives.find((q) => q.id === c.id);
      if (ex) ex.level = Math.min(PASSIVES[c.id].max, ex.level + 1);
      else if (p.passives.length < MAX_PASSIVES) p.passives.push({ id: c.id, level: 1 });
      break;
    }
    case 'relic': {
      if (!sim.hasRelic(c.id)) {
        p.relics.push(c.id);
        if (c.id === 'phoenix') p.revives++;
      }
      break;
    }
    case 'heal':
      sim.heal(p.st.maxHp * 0.3);
      break;
    case 'cinder':
      sim.stats.cinders += 25;
      break;
    case 'boon':
      applyBoon(sim, c.id);
      break;
    case 'awaken':
      sim.awakening = c.id;
      break;
  }
  sim.recalc();
  if (c.type === 'relic' && c.id === 'secondwind') p.dashCharges = p.st.dashMax;
}

const BOONS: BoonId[] = ['blood', 'ward', 'fury', 'swift', 'tithe', 'renew', 'gamble', 'forge', 'oath', 'insight'];

/** a shrine offers three bargains; picking one is optional (skip) */
export function makeShrinePending(sim: Sim): Pending {
  const list = BOONS.filter((b) => (b !== 'blood' || RELIC_IDS.some((r) => !sim.hasRelic(r))) && (b !== 'forge' || sim.player.weapons.some((w) => w.level < MAX_WEAPON_LEVEL)) && (b !== 'oath' || sim.pacts.size < PACT_IDS.length));
  sim.rng.shuffle(list);
  return { type: 'shrine', choices: list.slice(0, 3).map((id) => ({ type: 'boon', id }) as Choice) };
}

function applyBoon(sim: Sim, id: BoonId) {
  const p = sim.player;
  switch (id) {
    case 'blood': {
      p.hp = Math.max(1, p.hp - p.hp * 0.25);
      const avail = RELIC_IDS.filter((r) => !sim.hasRelic(r));
      if (avail.length) applyChoice(sim, { type: 'relic', id: avail[Math.floor(sim.rng.next() * avail.length)] });
      break;
    }
    case 'ward': sim.boons.hp += 25; p.hp += 25; break;
    case 'fury': sim.boons.might += 0.15; sim.spawnBoost *= 1.12; break;
    case 'swift': sim.boons.dashCd += 0.2; sim.boons.speed += 0.06; break;
    case 'tithe': sim.stats.cinders += 45; break;
    case 'forge': {
      const ups = p.weapons.filter((w) => w.level < MAX_WEAPON_LEVEL);
      if (ups.length) ups[Math.floor(sim.rng.next() * ups.length)].level++;
      sim.boons.hp -= 10;
      break;
    }
    case 'oath': {
      const left = PACT_IDS.filter((x) => !sim.pacts.has(x));
      if (left.length) {
        const id = left[Math.floor(sim.rng.next() * left.length)];
        sim.addPact(id);
        sim.events.push({ t: 'announce', key: 'ann.pact.' + id, tone: 'warn' });
      }
      sim.stats.cinders += 30;
      sim.heal(p.st.maxHp * 0.3);
      break;
    }
    case 'insight': p.rerolls += 2; p.banishes += 1; break;
    case 'renew': p.hp = p.st.maxHp; p.slowT = 0; break;
    case 'gamble': {
      const ups = p.weapons.filter((w) => w.level < MAX_WEAPON_LEVEL);
      if (sim.rng.next() < 0.5 && ups.length) {
        const w = ups[Math.floor(sim.rng.next() * ups.length)];
        w.level = Math.min(MAX_WEAPON_LEVEL, w.level + 2);
        sim.events.push({ t: 'announce', key: 'boon.gamble.win', tone: 'good' });
      } else {
        p.hp = Math.max(1, p.hp - p.st.maxHp * 0.2);
        sim.events.push({ t: 'announce', key: 'boon.gamble.lose', tone: 'warn' });
      }
      break;
    }
  }
}

/** Chests apply their rewards immediately; the pending entry only drives the reveal screen. */
export function makeChestPending(sim: Sim): Pending {
  const luck = sim.player.st.luck;
  const r = sim.rng.next();
  const n = r < 0.06 * luck ? 5 : r < 0.28 * luck ? 3 : 1;
  const got: Choice[] = [];
  for (let i = 0; i < n; i++) {
    // evolutions first, then upgrades to things already owned
    const all = pool(sim);
    const evo = all.filter((x) => x.c.type === 'evolve');
    const owned = all.filter((x) => (x.c.type === 'weapon' || x.c.type === 'passive') && !x.c.isNew);
    const pickFrom = evo.length > 0 ? evo : owned.length > 0 ? owned : all;
    const c = draw(sim, pickFrom, 1)[0];
    if (!c) break;
    applyChoice(sim, c);
    got.push(c);
  }
  const cinders = sim.rng.int(8, 16) * n;
  sim.stats.cinders += cinders;
  if (got.length === 0) {
    sim.heal(sim.player.st.maxHp * 0.3);
    got.push({ type: 'heal' });
  }
  return { type: 'chest', choices: got, cinders };
}

/** UI entry points -------------------------------------------------- */
export function choose(sim: Sim, index: number) {
  const pend = sim.pending[0];
  if (!pend) return;
  if (pend.type !== 'chest') {
    const c = pend.choices[index];
    if (!c) return;
    applyChoice(sim, c);
  }
  sim.pending.shift();
  refreshQueued(sim);
}

export function reroll(sim: Sim): boolean {
  const pend = sim.pending[0];
  if (!pend || pend.type !== 'levelup' || sim.player.rerolls <= 0) return false;
  sim.player.rerolls--;
  pend.choices = rollLevelChoices(sim);
  return true;
}

export function banish(sim: Sim, index: number): boolean {
  const pend = sim.pending[0];
  if (!pend || pend.type !== 'levelup' || sim.player.banishes <= 0) return false;
  const c = pend.choices[index];
  if (!c || c.type === 'heal' || c.type === 'cinder' || c.type === 'evolve') return false;
  sim.player.banishes--;
  sim.banished.add(choiceKey(c));
  pend.choices = rollLevelChoices(sim);
  return true;
}

export function skip(sim: Sim) {
  const pend = sim.pending[0];
  if (!pend || pend.type === 'chest' || pend.type === 'awaken') return;
  sim.pending.shift();
  refreshQueued(sim);
}

/** choices queued earlier may be stale after an upgrade was taken; re-roll them */
function refreshQueued(sim: Sim) {
  for (const q of sim.pending) {
    if (q.type === 'levelup') q.choices = rollLevelChoices(sim);
  }
}
