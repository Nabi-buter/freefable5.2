import type { Sim } from './sim';
import type { Enemy } from './types';
import { ENEMIES, type EnemyKind } from './defs';

export interface DirectorState {
  budget: number;
  next: EnemyKind;
  eliteT: number;
  swarmT: number;
  graceT: number;
}

export function initDirector(): DirectorState {
  return { budget: 3, next: 'shade', eliteT: 55, swarmT: 95, graceT: 1.5 };
}

const UNLOCKS: { kind: EnemyKind; at: number; w: number }[] = [
  { kind: 'shade', at: 0, w: 10 },
  { kind: 'skitter', at: 0.75, w: 6 },
  { kind: 'bomber', at: 2.4, w: 2.6 },
  { kind: 'spitter', at: 3.4, w: 2.8 },
  { kind: 'brute', at: 4.6, w: 2.2 },
  { kind: 'wraith', at: 6.0, w: 2.8 },
  { kind: 'husk', at: 7.4, w: 2.6 },
];

function pickKind(sim: Sim, I: number): EnemyKind {
  let total = 0;
  for (const u of UNLOCKS) if (I >= u.at) total += u.kind === 'shade' ? Math.max(4, u.w - I * 0.35) : u.w;
  let r = sim.rng.next() * total;
  for (const u of UNLOCKS) {
    if (I < u.at) continue;
    r -= u.kind === 'shade' ? Math.max(4, u.w - I * 0.35) : u.w;
    if (r <= 0) return u.kind;
  }
  return 'shade';
}

export function updateDirector(sim: Sim, dt: number) {
  const d = sim.dir;
  if (sim.endT >= 0) return;
  if (d.graceT > 0) {
    d.graceT -= dt;
    return;
  }
  const I = sim.intensity();
  const p = sim.player;
  let channeling = false;
  for (const b of sim.beacons) if (b.channeling) channeling = true;
  let rate = (1.1 + 0.6 * I + 0.09 * I * I) * sim.diff.spawn;
  if (channeling) rate *= 1.6;
  if (sim.boss) rate *= 0.4;
  const maxAlive = Math.min(440, 50 + 30 * I);
  const alive = sim.enemies.length;
  // if the field is nearly empty, top up faster so there is always something to fight
  if (alive < 8 + I * 2) rate *= 2.2;
  d.budget = Math.min(d.budget + rate * dt, 60);
  const moveA = p.moving ? Math.atan2(p.vz, p.vx) : undefined;
  let guard = 0;
  while (d.budget >= ENEMIES[d.next].cost && sim.enemies.length < maxAlive && guard++ < 12) {
    const kind = d.next;
    d.budget -= ENEMIES[kind].cost;
    // half of the spawns arrive in front of the player's movement to keep pressure on
    const bias = moveA !== undefined && sim.rng.chance(0.45) ? moveA : undefined;
    const pos = sim.ringPoint(26, 33, ENEMIES[kind].radius, bias);
    if (kind === 'skitter') {
      const n = sim.rng.int(3, 5);
      d.budget -= ENEMIES[kind].cost * (n - 1) * 0.6;
      for (let i = 0; i < n; i++) sim.spawnEnemy(kind, pos.x + sim.rng.range(-1.5, 1.5), pos.z + sim.rng.range(-1.5, 1.5));
    } else sim.spawnEnemy(kind, pos.x, pos.z);
    d.next = pickKind(sim, I);
  }
  // elites
  d.eliteT -= dt;
  if (d.eliteT <= 0) {
    d.eliteT = sim.rng.range(48, 62);
    let kind = pickKind(sim, I);
    if (kind === 'skitter' || kind === 'bomber') kind = 'shade';
    const pos = sim.ringPoint(24, 28, 1.5);
    sim.spawnEnemy(kind, pos.x, pos.z, true);
    sim.events.push({ t: 'spawnElite', x: pos.x, z: pos.z });
    sim.events.push({ t: 'announce', key: 'ann.elite', tone: 'warn' });
  }
  // encirclement swarms
  d.swarmT -= dt;
  if (d.swarmT <= 0 && !sim.boss) {
    d.swarmT = sim.rng.range(70, 90);
    const n = Math.min(60, Math.round(18 + I * 2.2));
    const kind: EnemyKind = I > 5 && sim.rng.chance(0.4) ? 'shade' : 'skitter';
    const off = sim.rng.angle();
    const lim = sim.world.playRadius + 2;
    for (let i = 0; i < n; i++) {
      const a = off + (i / n) * Math.PI * 2;
      const x = p.x + Math.cos(a) * 25, z = p.z + Math.sin(a) * 25;
      if (x * x + z * z > lim * lim) continue;
      sim.spawnEnemy(kind, x, z);
    }
    sim.events.push({ t: 'announce', key: 'ann.swarm', tone: 'warn' });
  }
}

function fireRing(sim: Sim, e: Enemy, n: number, speed: number, dmg: number, off: number, kind = 1) {
  for (let i = 0; i < n; i++) {
    const a = off + (i / n) * Math.PI * 2;
    sim.eprojs.push({ id: sim.id(), x: e.x + Math.cos(a) * e.r, z: e.z + Math.sin(a) * e.r, vx: Math.cos(a) * speed, vz: Math.sin(a) * speed, life: 6, r: 0.42, dmg, kind, alive: true });
  }
  sim.events.push({ t: 'spit', x: e.x, z: e.z });
}

function slam(sim: Sim, x: number, z: number, r: number, delay: number, dmg: number) {
  sim.zones.push({ id: sim.id(), kind: 'slam', x, z, r, t: 0, dur: delay, dmg, tick: 0, hostile: true, weapon: null, evolved: false, dx: 0, dz: 0, len: 0, alive: true });
}

export function updateEnemies(sim: Sim, dt: number) {
  const p = sim.player;
  const world = sim.world;
  const I = sim.intensity();
  const lim = world.playRadius + 4;
  const all = [sim.enemies, sim.bigs];
  for (let li = 0; li < 2; li++) {
    const list = all[li];
    // note: list can grow during iteration (summons); new entries are processed next frame
    const count = list.length;
    for (let i = 0; i < count; i++) {
      const e = list[i];
      if (!e.alive) continue;
      e.t += dt;
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt * 6);
      if (e.cdA > 0) e.cdA -= dt;
      if (e.cdB > 0) e.cdB -= dt;
      if (e.spawn < 1) e.spawn = Math.min(1, e.spawn + dt * 1.9);
      // burn
      if (e.burnT > 0) {
        e.burnT -= dt;
        e.burnAcc += e.burnDps * dt;
        if (e.burnAcc >= e.burnDps * 0.45 || e.burnT <= 0) {
          const d = e.burnAcc;
          e.burnAcc = 0;
          sim.applyDamage(e, d, null, false, 0, 0, 0, d < 3);
          if (!e.alive) continue;
        }
      }
      let speedMul = 1;
      if (e.freezeT > 0) {
        e.freezeT -= dt;
        speedMul = 0;
      } else if (e.chillT > 0) {
        e.chillT -= dt;
        speedMul = 0.55;
      }
      // knockback
      if (e.kx !== 0 || e.kz !== 0) {
        e.x += e.kx * dt;
        e.z += e.kz * dt;
        const f = Math.exp(-9 * dt);
        e.kx *= f;
        e.kz *= f;
        if (Math.abs(e.kx) + Math.abs(e.kz) < 0.05) e.kx = e.kz = 0;
      }
      const dx = p.x - e.x, dz = p.z - e.z;
      const dist = Math.hypot(dx, dz) || 0.001;
      const nx = dx / dist, nz = dz / dist;
      let vx = 0, vz = 0;
      const active = e.spawn >= 0.75 && speedMul > 0;
      e.tele = 0;
      if (active) {
        switch (e.def.ai) {
          case 'chase': {
            // weave a little so groups do not move as a single blob
            const w = Math.sin(e.t * 1.7 + e.seed * 40) * 0.28;
            vx = (nx - nz * w) * e.speed;
            vz = (nz + nx * w) * e.speed;
            break;
          }
          case 'ranged': {
            const want = 10;
            let f = 0;
            if (dist > want + 2) f = 1;
            else if (dist < want - 3) f = -0.8;
            const side = e.seed > 0.5 ? 1 : -1;
            vx = (nx * f - nz * side * 0.5) * e.speed;
            vz = (nz * f + nx * side * 0.5) * e.speed;
            e.stT += dt * speedMul;
            if (e.stT > 2.2 && dist < 17) e.tele = 1;
            if (e.stT >= 2.7 && dist < 17) {
              e.stT = sim.rng.range(-0.3, 0.3);
              const sp = 9.5;
              sim.eprojs.push({ id: sim.id(), x: e.x + nx * 0.6, z: e.z + nz * 0.6, vx: nx * sp, vz: nz * sp, life: 3.2, r: 0.38, dmg: e.dmg, kind: 0, alive: true });
              sim.events.push({ t: 'spit', x: e.x, z: e.z });
            }
            break;
          }
          case 'charger': {
            e.stT += dt * speedMul;
            if (e.st === 0) {
              vx = nx * e.speed;
              vz = nz * e.speed;
              if (dist < 11 && e.stT > 1.2) {
                e.st = 1;
                e.stT = 0;
              }
            } else if (e.st === 1) {
              e.tele = 1;
              e.ax = nx;
              e.az = nz;
              if (e.stT >= 0.75) {
                e.st = 2;
                e.stT = 0;
                sim.events.push({ t: 'charge', x: e.x, z: e.z });
              }
            } else if (e.st === 2) {
              vx = e.ax * 17;
              vz = e.az * 17;
              if (e.stT >= 0.55) {
                e.st = 3;
                e.stT = 0;
              }
            } else {
              vx = nx * e.speed * 0.3;
              vz = nz * e.speed * 0.3;
              if (e.stT >= 0.9) {
                e.st = 0;
                e.stT = 0;
              }
            }
            break;
          }
          case 'bomber': {
            if (e.st === 0) {
              vx = nx * e.speed;
              vz = nz * e.speed;
              if (dist < 2.3) {
                e.st = 1;
                e.stT = 0;
              }
            } else {
              e.tele = 1;
              e.stT += dt;
              if (e.stT >= 0.6) {
                const R = 3.4;
                sim.events.push({ t: 'explode', x: e.x, z: e.z, r: R, c: 0xff4a6a, hostile: true });
                if (dist < R + 0.4) sim.hurtPlayer(e.dmg, e.x, e.z);
                e.alive = false;
                sim.events.push({ t: 'kill', x: e.x, z: e.z, kind: e.kind, elite: false, r: e.r });
                continue;
              }
            }
            break;
          }
          case 'herald': {
            vx = nx * e.speed;
            vz = nz * e.speed;
            e.stT += dt;
            const hpf = e.hp / e.maxHp;
            if (e.st > 0) {
              // wind-up: stand still
              vx = vz = 0;
              e.tele = 1;
              if (e.stT >= 0.7) {
                e.st = 0;
                e.stT = 0;
              }
            } else if (e.stT >= (hpf < 0.5 ? 2.6 : 3.4)) {
              e.stT = 0;
              e.st = 1;
              e.n++;
              if (e.n % 3 === 0) {
                fireRing(sim, e, 12, 8, e.dmg * 0.7, sim.rng.angle());
              } else {
                slam(sim, p.x, p.z, 4.6, 1.0, e.dmg * 1.3);
                if (hpf < 0.5) {
                  const a = sim.rng.angle();
                  slam(sim, p.x + Math.cos(a) * 6, p.z + Math.sin(a) * 6, 4, 1.35, e.dmg * 1.3);
                  slam(sim, p.x - Math.cos(a) * 6, p.z - Math.sin(a) * 6, 4, 1.7, e.dmg * 1.3);
                }
              }
              if (e.n % 4 === 0) {
                for (let k = 0; k < 5; k++) {
                  const a = sim.rng.angle();
                  sim.spawnEnemy('shade', e.x + Math.cos(a) * 3, e.z + Math.sin(a) * 3);
                }
              }
            }
            break;
          }
          case 'eclipse': {
            updateEclipse(sim, e, dt, dist, nx, nz);
            vx = e.ax;
            vz = e.az;
            break;
          }
        }
      }
      vx *= speedMul;
      vz *= speedMul;
      // separation from neighbours (skip for bosses)
      if (!e.boss && active) {
        const nb = sim.near(e.x, e.z, e.r * 0.9);
        let sx = 0, sz = 0;
        for (let k = 0; k < nb.length && k < 6; k++) {
          const o = nb[k];
          if (o === e || o.boss) continue;
          const ox = e.x - o.x, oz = e.z - o.z;
          const od = Math.hypot(ox, oz) || 0.01;
          const overlap = e.r + o.r - od;
          if (overlap > 0) {
            const wgt = o.def.mass / (o.def.mass + e.def.mass);
            sx += (ox / od) * overlap * wgt;
            sz += (oz / od) * overlap * wgt;
          }
        }
        e.x += sx * Math.min(1, dt * 14);
        e.z += sz * Math.min(1, dt * 14);
      }
      e.x += vx * dt;
      e.z += vz * dt;
      if (vx !== 0 || vz !== 0) {
        const target = Math.atan2(vz, vx);
        let da = target - e.face;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        e.face += da * Math.min(1, dt * 10);
      } else if (e.tele) {
        e.face = Math.atan2(nz, nx);
      }
      if (!e.boss) world.resolve(e, e.r * 0.8);
      const ed = e.x * e.x + e.z * e.z;
      if (ed > lim * lim) {
        const s = lim / Math.sqrt(ed);
        e.x *= s;
        e.z *= s;
      }
      // contact damage
      if (active && dist < e.r + 0.5 && !(e.def.ai === 'bomber')) {
        if (sim.hurtPlayer(e.dmg, e.x, e.z) && !e.boss) {
          e.kx -= nx * 5;
          e.kz -= nz * 5;
        }
      }
      // recycle stragglers so the horde keeps up with a moving player
      if (dist > 58 && !e.boss && !e.elite) {
        const pos = sim.ringPoint(27, 33, e.r, p.moving ? Math.atan2(p.vz, p.vx) : undefined);
        e.x = pos.x;
        e.z = pos.z;
        e.spawn = 0;
        e.kx = e.kz = 0;
      }
    }
  }
  void I;
}

/** Final boss brain. Writes desired velocity into e.ax/e.az. e.st = current move, e.n = move counter. */
function updateEclipse(sim: Sim, e: Enemy, dt: number, dist: number, nx: number, nz: number) {
  const p = sim.player;
  const hpf = e.hp / e.maxHp;
  const phase = hpf > 0.62 ? 1 : hpf > 0.3 ? 2 : 3;
  if (phase !== e.phase) {
    e.phase = phase;
    if (phase > 1) {
      sim.events.push({ t: 'bossPhase', phase });
      sim.events.push({ t: 'announce', key: phase === 2 ? 'ann.phase2' : 'ann.phase3', tone: 'warn' });
      fireRing(sim, e, 28, 9, e.dmg * 0.6, 0);
      e.st = 0;
      e.stT = -0.8;
    }
  }
  const pace = phase === 1 ? 1 : phase === 2 ? 0.82 : 0.66;
  const drift = phase === 3 ? 1.25 : 1;
  e.ax = nx * e.speed * drift;
  e.az = nz * e.speed * drift;
  if (dist < e.r + 1.5) {
    e.ax = e.az = 0;
  }
  e.stT += dt;
  switch (e.st) {
    case 0: {
      // idle / approach, then choose a move
      if (e.stT >= 1.5 * pace) {
        e.n++;
        const moves = phase === 1 ? [1, 2, 3] : phase === 2 ? [1, 4, 2, 5, 3] : [4, 2, 5, 1, 5, 3];
        e.st = moves[e.n % moves.length];
        e.stT = 0;
        e.c1 = 0;
      }
      break;
    }
    case 1: {
      // double ring burst
      e.ax *= 0.3;
      e.az *= 0.3;
      e.tele = 1;
      const shots = phase === 1 ? 2 : 3;
      const idx = Math.floor(e.stT / 0.55);
      if (idx > e.c1 && idx <= shots) {
        e.c1 = idx;
        fireRing(sim, e, phase === 1 ? 16 : 20, 8.5, e.dmg * 0.6, idx * 0.2 + e.t);
      }
      if (e.stT > 0.55 * shots + 0.5) {
        e.st = 0;
        e.stT = 0;
      }
      break;
    }
    case 2: {
      // telegraphed charge
      if (e.stT < 0.9) {
        e.tele = 1;
        if (e.c1 === 0) {
          e.c1 = 1;
          // lock direction and show the lane
          e.kx = 0;
          e.kz = 0;
          const len = Math.min(34, dist + 12);
          sim.zones.push({ id: sim.id(), kind: 'charge', x: e.x, z: e.z, r: e.r + 0.6, t: 0, dur: 0.9, dmg: 0, tick: 0, hostile: true, weapon: null, evolved: false, dx: nx, dz: nz, len, alive: true });
          e.face = Math.atan2(nz, nx);
          e.lx = nx;
          e.lz = nz;
          e.ll = len;
        }
        e.ax = e.az = 0;
      } else {
        const sp = 30;
        e.ax = e.lx * sp;
        e.az = e.lz * sp;
        if (e.c1 === 1) {
          e.c1 = 2;
          sim.events.push({ t: 'charge', x: e.x, z: e.z });
        }
        if (e.stT > 0.9 + e.ll / sp) {
          e.st = 0;
          e.stT = phase === 3 ? 0.6 : 0;
          fireRing(sim, e, 10, 7, e.dmg * 0.5, e.t);
        }
      }
      break;
    }
    case 3: {
      // summon
      e.ax *= 0.2;
      e.az *= 0.2;
      e.tele = 1;
      if (e.stT > 0.8 && e.c1 === 0) {
        e.c1 = 1;
        const n = phase === 1 ? 8 : phase === 2 ? 10 : 12;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          const kind: EnemyKind = k % 4 === 0 && phase > 1 ? 'wraith' : k % 2 === 0 ? 'shade' : 'skitter';
          sim.spawnEnemy(kind, e.x + Math.cos(a) * 5, e.z + Math.sin(a) * 5);
        }
        sim.events.push({ t: 'nova', x: e.x, z: e.z, r: 6, c: 0xb04aff });
      }
      if (e.stT > 1.5) {
        e.st = 0;
        e.stT = 0;
      }
      break;
    }
    case 4: {
      // spiral stream
      e.ax *= 0.25;
      e.az *= 0.25;
      e.tele = 1;
      const rate = phase === 2 ? 0.085 : 0.065;
      e.cdA -= dt;
      if (e.stT > 0.4 && e.cdA <= 0) {
        e.cdA = rate;
        const arms = phase === 2 ? 2 : 3;
        for (let k = 0; k < arms; k++) {
          const a = e.stT * 2.6 + (k / arms) * Math.PI * 2;
          sim.eprojs.push({ id: sim.id(), x: e.x + Math.cos(a) * e.r, z: e.z + Math.sin(a) * e.r, vx: Math.cos(a) * 9, vz: Math.sin(a) * 9, life: 5, r: 0.4, dmg: e.dmg * 0.55, kind: 1, alive: true });
        }
      }
      if (e.stT > 3.4) {
        e.st = 0;
        e.stT = 0;
      }
      break;
    }
    case 5: {
      // falling stars around the player
      e.tele = 1;
      const n = phase === 2 ? 6 : 9;
      const idx = Math.floor(e.stT / 0.28);
      if (idx > e.c1 && idx <= n) {
        e.c1 = idx;
        const a = sim.rng.angle();
        const d = idx === 1 ? 0 : sim.rng.range(1.5, 8.5);
        slam(sim, p.x + Math.cos(a) * d + p.vx * 0.5, p.z + Math.sin(a) * d + p.vz * 0.5, 3.6, 1.05, e.dmg * 1.1);
      }
      if (e.stT > 0.28 * n + 0.8) {
        e.st = 0;
        e.stT = 0;
      }
      break;
    }
  }
}
