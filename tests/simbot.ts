/**
 * Headless balance bot. Plays full runs against the pure simulation and prints a timeline.
 *   npx tsx tests/simbot.ts [runs] [difficulty] [char] [skill]
 */
import { Sim } from '../src/sim/sim';
import { choose } from '../src/sim/choices';
import type { InputState } from '../src/sim/types';
import { CHAR_IDS, type CharId } from '../src/sim/defs';
import type { BiomeId } from '../src/sim/worldgen';

export interface BotResult {
  win: boolean;
  time: number;
  level: number;
  kills: number;
  beacons: number;
  hpLow: number;
  weapons: string;
  log: string[];
  stepMs: number;
  maxEnemies: number;
}

/** skill 0..1: how well the bot dodges */
export function runBot(seed: number, difficulty = 0, char: CharId = 'kindler', skill = 0.7, maxTime = 1500, verbose = false, biome: BiomeId = 'ashwood'): BotResult {
  const sim = new Sim({ seed, char, difficulty, biome, meta: {} });
  const input: InputState = { mx: 0, mz: 0, aimX: 1, aimZ: 0, autoAim: true, dash: false };
  const dt = 1 / 60;
  const log: string[] = [];
  let nextLog = 60;
  let hpLow = 1;
  let maxEnemies = 0;
  const t0 = performance.now();
  let steps = 0;
  let wander = 0;
  while (sim.state === 'playing' && sim.time < maxTime) {
    while (sim.pending.length > 0) {
      const pend = sim.pending[0];
      // prefer evolutions, then upgrades for owned weapons, then anything
      let best = 0, bs = -1;
      pend.choices.forEach((c, i) => {
        let s = Math.random();
        if (c.type === 'evolve') s += 10;
        else if (c.type === 'weapon') s += c.isNew ? (sim.player.weapons.length < 4 ? 3 : 1.5) : 2.2;
        else if (c.type === 'passive') s += 1;
        if (s > bs) {
          bs = s;
          best = i;
        }
      });
      choose(sim, best);
    }
    const p = sim.player;
    // --- steering: flee from nearby threats, otherwise go to the nearest unlit beacon
    let fx = 0, fz = 0, threat = 0;
    // melee-only builds must let enemies come close
    const melee = p.weapons.every((w) => w.id === 'wisps' || w.id === 'aura' || w.id === 'nova');
    const fear = melee ? 2.4 : 5.5;
    const consider = (x: number, z: number, r: number, weight: number) => {
      const dx = p.x - x, dz = p.z - z;
      const d = Math.hypot(dx, dz) || 0.01;
      const reach = r + fear;
      if (d < reach) {
        const w = (weight * (reach - d)) / reach;
        fx += (dx / d) * w;
        fz += (dz / d) * w;
        threat += w;
      }
    };
    for (const e of sim.enemies) consider(e.x, e.z, e.r, e.def.ai === 'bomber' ? 2 : 1);
    for (const e of sim.bigs) consider(e.x, e.z, e.r + 2, 4);
    for (const b of sim.eprojs) consider(b.x + b.vx * 0.2, b.z + b.vz * 0.2, 0.5, 2.5);
    for (const z of sim.zones) if (z.hostile && (z.kind === 'slam' || z.kind === 'vent' || z.kind === 'frost')) consider(z.x, z.z, z.r - 3, 6);
    let gx = 0, gz = 0;
    let target = null as null | { x: number; z: number };
    let bd = 1e9;
    for (const b of sim.beacons) {
      if (b.lit) continue;
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      if (d < bd) {
        bd = d;
        target = b;
      }
    }
    // only push for beacons when strong enough for the current count
    const ready = p.level >= 4 + sim.stats.beacons * 5;
    // embers nearby always tug at the bot, like they do at a human player
    let px = 0, pz = 0, pn = 0;
    for (const k of sim.pickups) {
      if (k.kind !== 'xp' && k.kind !== 'chest' && k.kind !== 'heal') continue;
      const d = Math.hypot(k.x - p.x, k.z - p.z);
      if (d < 13 && d > 0.5) {
        const w = k.kind === 'chest' ? 6 : 1;
        px += ((k.x - p.x) / d) * w;
        pz += ((k.z - p.z) / d) * w;
        pn += w;
      }
    }
    const pl = Math.hypot(px, pz) || 1;
    if (target && ready) {
      const d = Math.hypot(target.x - p.x, target.z - p.z) || 1;
      if (d > 3) {
        gx = (target.x - p.x) / d;
        gz = (target.z - p.z) / d;
      }
      // detour for embers while travelling, but hold the ring once channeling
      if (pn > 0 && d > 7) {
        gx = gx * 0.55 + (px / pl) * 0.45;
        gz = gz * 0.55 + (pz / pl) * 0.45;
      }
    } else if (pn > 0) {
      gx = px / pl;
      gz = pz / pl;
    } else {
      wander += dt * 0.25;
      gx = Math.cos(wander);
      gz = Math.sin(wander);
    }
    const tw = Math.min(1, threat * (0.6 + skill));
    let mx = gx * (1 - tw * 0.85) + fx * skill * 1.6;
    let mz = gz * (1 - tw * 0.85) + fz * skill * 1.6;
    const ml = Math.hypot(mx, mz);
    if (ml > 0.01) {
      mx /= ml;
      mz /= ml;
    }
    input.mx = mx;
    input.mz = mz;
    input.dash = threat > 2.2 && Math.random() < skill * 0.2;
    sim.step(dt, input);
    sim.events.length = 0;
    steps++;
    hpLow = Math.min(hpLow, p.hp / p.st.maxHp);
    maxEnemies = Math.max(maxEnemies, sim.enemies.length);
    if (sim.time >= nextLog) {
      nextLog += 60;
      const ws = p.weapons.map((w) => `${w.id}${w.level}`).join(',');
      const line = `  t=${(sim.time / 60).toFixed(0)}m lvl=${p.level} hp=${Math.round(p.hp)}/${p.st.maxHp} en=${sim.enemies.length} kills=${sim.stats.kills} beacons=${sim.stats.beacons} dps=${Math.round(sim.stats.dmgDealt / sim.time)} [${ws}] boss=${sim.boss ? Math.round((sim.boss.hp / sim.boss.maxHp) * 100) + '%' : '-'}`;
      log.push(line);
      if (verbose) console.log(line);
    }
  }
  const p = sim.player;
  return {
    win: sim.state === 'victory',
    time: sim.time,
    level: p.level,
    kills: sim.stats.kills,
    beacons: sim.stats.beacons,
    hpLow,
    weapons: p.weapons.map((w) => `${w.id}${w.level}`).join(',') + ' | ' + p.passives.map((w) => `${w.id}${w.level}`).join(',') + ' | ' + p.relics.join(','),
    log,
    stepMs: (performance.now() - t0) / steps,
    maxEnemies,
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith('simbot.ts');
if (isMain) {
  const runs = Number(process.argv[2] ?? 4);
  const diff = Number(process.argv[3] ?? 0);
  const charArg = process.argv[4] ?? 'kindler';
  const skill = Number(process.argv[5] ?? 0.7);
  const biome = (process.argv[6] ?? 'ashwood') as BiomeId;
  let wins = 0;
  for (let i = 0; i < runs; i++) {
    const char = (charArg === 'all' ? CHAR_IDS[i % CHAR_IDS.length] : charArg) as CharId;
    const r = runBot(1000 + i * 7919, diff, char, skill, 1500, runs === 1, biome);
    if (r.win) wins++;
    console.log(`#${i} ${char} ${r.win ? 'WIN ' : 'LOSS'} t=${(r.time / 60).toFixed(1)}m lvl=${r.level} kills=${r.kills} beacons=${r.beacons} minHp=${(r.hpLow * 100).toFixed(0)}% maxEn=${r.maxEnemies} step=${r.stepMs.toFixed(3)}ms`);
    console.log('   ' + r.weapons);
    if (runs <= 3 && runs !== 1) r.log.forEach((l) => console.log(l));
  }
  console.log(`wins ${wins}/${runs}`);
}
