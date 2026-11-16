/**
 * Signature abilities: one active skill per lightbearer on a long cooldown.
 * Their damage is partly a share of the target's health so they clear the horde at any point of a run
 * without deleting elites or bosses.
 */
import type { SkillId } from './defs';
import type { Enemy } from './types';
import type { Sim } from './sim';
import { zone } from './weapons';

/** flat damage plus a share of max health (much smaller against elites, tiny against bosses) */
function strike(sim: Sim, e: Enemy, flat: number, frac: number, kb: number) {
  const p = sim.player;
  const share = e.boss ? 0.012 : e.elite ? frac * 0.3 : frac;
  sim.applyDamage(e, flat * p.st.might + e.maxHp * share, null, false, kb, p.x, p.z);
}

export function skillReady(sim: Sim): boolean {
  return sim.player.alive && sim.player.skillCd <= 0;
}

export function castSkill(sim: Sim): boolean {
  const p = sim.player;
  if (!skillReady(sim)) return false;
  const id: SkillId = sim.char.skill;
  const L = p.level;
  const area = p.st.area;
  p.skillCd = sim.skillCooldown();
  let radius = 0;
  switch (id) {
    case 'flare': {
      radius = 9.5 * area;
      const list = sim.near(p.x, p.z, radius);
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        strike(sim, e, 40 + 8 * L, 0.5, 16);
        if (e.alive) sim.burn(e, 6 + 2 * L, 4);
      }
      break;
    }
    case 'tempest': {
      radius = 17;
      const list = sim.near(p.x, p.z, radius).slice();
      // nearest first, elites and bosses always included
      list.sort((a, b) => (b.elite || b.boss ? 1e6 : 0) - (a.elite || a.boss ? 1e6 : 0) + ((a.x - p.x) ** 2 + (a.z - p.z) ** 2) - ((b.x - p.x) ** 2 + (b.z - p.z) ** 2));
      const n = Math.min(list.length, 8 + Math.floor(L / 8));
      for (let i = 0; i < n; i++) {
        const e = list[i];
        if (!e.alive) continue;
        sim.events.push({ t: 'lightning', pts: [p.x, p.z, e.x, e.z] });
        strike(sim, e, 50 + 9 * L, 0.6, 4);
        if (e.alive) sim.chill(e, 2.5);
        // each bolt splashes
        const nb = sim.near(e.x, e.z, 2.6);
        for (let k = 0; k < nb.length; k++) if (nb[k] !== e) strike(sim, nb[k], 18 + 4 * L, 0.25, 3);
      }
      break;
    }
    case 'bulwark': {
      radius = 7.5 * area;
      p.skillT = 3;
      p.iframe = Math.max(p.iframe, 3);
      sim.heal(p.st.maxHp * 0.22);
      const list = sim.near(p.x, p.z, radius);
      for (let i = 0; i < list.length; i++) strike(sim, list[i], 25 + 5 * L, 0.3, 24);
      // hostile shots in the air are swatted away
      for (const b of sim.eprojs) {
        const dx = b.x - p.x, dz = b.z - p.z;
        if (dx * dx + dz * dz < radius * radius) b.alive = false;
      }
      break;
    }
    case 'deepfreeze': {
      radius = 13 * area;
      const list = sim.near(p.x, p.z, radius);
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        strike(sim, e, 15 + 4 * L, 0.2, 0);
        if (!e.alive) continue;
        if (e.boss) sim.chill(e, 7);
        else {
          sim.freeze(e, 3.5);
          sim.chill(e, 6);
        }
      }
      break;
    }
    case 'cinderstep': {
      radius = 3;
      p.skillT = 4.5;
      p.skillAcc = 99;
      p.dashCharges = p.st.dashMax;
      p.iframe = Math.max(p.iframe, 0.6);
      p.slowT = 0;
      break;
    }
  }
  sim.events.push({ t: 'skill', id, x: p.x, z: p.z, r: radius });
  return true;
}

/** cooldown and lingering effects. Called every substep. */
export function updateSkill(sim: Sim, dt: number) {
  const p = sim.player;
  if (p.skillCd > 0) {
    p.skillCd -= dt;
    if (p.skillCd <= 0) {
      p.skillCd = 0;
      sim.events.push({ t: 'skillReady' });
    }
  }
  if (p.skillT > 0) {
    p.skillT -= dt;
    if (sim.char.skill === 'cinderstep') {
      // a blazing wake behind every step
      p.skillAcc += Math.hypot(p.vx, p.vz) * dt;
      if (p.skillAcc > 1.7) {
        p.skillAcc = 0;
        zone(sim, 'fire', p.x, p.z, 2.5 * p.st.area, 3.2, 9 + 2.4 * p.level + sim.intensity() * 3, null, false);
      }
    }
  }
}
