import type { Sim } from './sim';
import type { Enemy, InputState, Proj, WeaponInst, Zone } from './types';
import { EVOLVED_LEVEL, WEAPONS, type WStats, type WeaponId } from './defs';
import { TAU } from '../core/rng';

export function wstats(w: WeaponInst): WStats {
  return WEAPONS[w.id].levels[w.level - 1];
}

function spawnProj(sim: Sim, kind: Proj['kind'], weapon: WeaponId, x: number, z: number, vx: number, vz: number, life: number, r: number, dmg: number, pierce: number, evolved: boolean): Proj {
  const pr: Proj = { id: sim.id(), kind, weapon, x, z, vx, vz, life, maxLife: life, r, dmg, pierce, hits: [], target: null, evolved, phase: 0, spin: 0, alive: true };
  sim.projs.push(pr);
  return pr;
}

export function zone(sim: Sim, kind: Zone['kind'], x: number, z: number, r: number, dur: number, dmg: number, weapon: WeaponId | null, evolved: boolean, hostile = false): Zone {
  const zn: Zone = { id: sim.id(), kind, x, z, r, t: 0, dur, dmg, tick: 0, hostile, weapon, evolved, dx: 0, dz: 0, len: 0, alive: true };
  sim.zones.push(zn);
  return zn;
}

export function updateWeapons(sim: Sim, dt: number, input: InputState) {
  const p = sim.player;
  if (!p.alive) return;
  const st = p.st;
  for (let wi = 0; wi < p.weapons.length; wi++) {
    const w = p.weapons[wi];
    const s = wstats(w);
    const evo = w.level >= EVOLVED_LEVEL;
    const cd = s.cd / st.haste;
    switch (w.id) {
      case 'ember': {
        w.t -= dt;
        if (w.t <= 0) {
          const target = input.autoAim ? sim.nearest(p.x, p.z, 26) : null;
          if (input.autoAim && !target) {
            w.t = 0.1;
            break;
          }
          w.t += cd;
          if (w.t < 0) w.t = 0;
          const d = sim.aimDir(input);
          const n = s.count + st.amount;
          const base = Math.atan2(d.z, d.x);
          const spread = Math.min(0.16, 0.7 / n);
          const sp = s.speed * st.projSpeed;
          for (let i = 0; i < n; i++) {
            const a = base + (i - (n - 1) / 2) * spread;
            spawnProj(sim, 'ember', 'ember', p.x + Math.cos(a) * 0.7, p.z + Math.sin(a) * 0.7, Math.cos(a) * sp, Math.sin(a) * sp, s.dur * st.dur, s.area, s.dmg, s.pierce, evo);
          }
          sim.events.push({ t: 'shoot', w: 'ember', x: p.x, z: p.z });
        }
        break;
      }
      case 'wisps': {
        const n = s.count + st.amount;
        const R = s.area * st.area;
        w.a += s.speed * dt * (0.8 + st.projSpeed * 0.2);
        const orb = 0.6 * Math.sqrt(st.area);
        for (let i = 0; i < n; i++) {
          const a = w.a + (i / n) * TAU;
          const ox = p.x + Math.cos(a) * R, oz = p.z + Math.sin(a) * R;
          const list = sim.near(ox, oz, orb);
          for (let k = 0; k < list.length; k++) {
            const e = list[k];
            if (e.cdA > 0) continue;
            e.cdA = 0.42;
            sim.damageEnemy(e, s.dmg, 'wisps', 7, p.x, p.z);
            if (evo) sim.burn(e, s.dmg * 0.5, 3);
          }
        }
        break;
      }
      case 'nova': {
        w.t -= dt;
        if (w.b > 0) {
          w.b -= dt;
          if (w.b <= 0) novaPulse(sim, s.area * st.area * 1.25, s.dmg * 0.7, true);
        }
        if (w.t <= 0) {
          w.t += cd;
          novaPulse(sim, s.area * st.area, s.dmg, evo);
          if (evo) w.b = 0.4;
          sim.events.push({ t: 'shoot', w: 'nova', x: p.x, z: p.z });
        }
        break;
      }
      case 'arc': {
        w.t -= dt;
        if (w.t <= 0) {
          const first = sim.nearest(p.x, p.z, 15);
          if (!first) {
            w.t = 0.15;
            break;
          }
          w.t += cd;
          if (w.t < 0) w.t = 0;
          const jumps = s.count + st.amount * 2;
          const range = s.area * Math.sqrt(st.area);
          const pts: number[] = [p.x, p.z];
          const skip = new Set<number>();
          let cur: Enemy | null = first;
          let hits = 0;
          while (cur && hits < jumps) {
            skip.add(cur.id);
            pts.push(cur.x, cur.z);
            const cx: number = cur.x, cz: number = cur.z;
            sim.damageEnemy(cur, s.dmg, 'arc', 2, p.x, p.z);
            if (evo && sim.rng.next() < 0.3) sim.freeze(cur, 0.6);
            hits++;
            cur = sim.nearest(cx, cz, range, skip);
          }
          sim.events.push({ t: 'lightning', pts });
          sim.events.push({ t: 'shoot', w: 'arc', x: p.x, z: p.z });
        }
        break;
      }
      case 'sprite': {
        const n = s.count + st.amount;
        const list = sim.sprites;
        while (list.length < n) list.push({ x: p.x, z: p.z, cd: 0.3 + list.length * 0.17, st: 0, tx: 0, tz: 0, t: 0, e: -1 });
        if (list.length > n) list.length = n;
        w.a += dt * 1.5;
        const reach = 9.5;
        const R = s.area * st.area;
        let taken: Set<number> | undefined;
        for (let i = 0; i < n; i++) {
          const sp = list[i];
          if (sp.st === 1) (taken ??= new Set()).add(sp.e);
        }
        for (let i = 0; i < n; i++) {
          const sp = list[i];
          if (sp.st === 0) {
            const a = w.a + (i / n) * Math.PI * 2;
            const hx = p.x + Math.cos(a) * 2.1, hz = p.z + Math.sin(a) * 2.1;
            const k = 1 - Math.exp(-9 * dt);
            sp.x += (hx - sp.x) * k;
            sp.z += (hz - sp.z) * k;
            sp.cd -= dt;
            if (sp.cd <= 0) {
              // spread out over different targets when there is a choice
              const e = sim.nearest(p.x, p.z, reach, taken) ?? sim.nearest(p.x, p.z, reach);
              if (e) {
                sp.st = 1;
                sp.tx = e.x;
                sp.tz = e.z;
                sp.t = 0;
                sp.e = e.id;
                (taken ??= new Set()).add(e.id);
              } else sp.cd = 0.12;
            }
          } else {
            sp.t += dt;
            const dx = sp.tx - sp.x, dz = sp.tz - sp.z;
            const d = Math.hypot(dx, dz);
            const step = s.speed * st.projSpeed * dt;
            if (d <= step + 0.3 || sp.t > 0.9) {
              sp.x = sp.tx;
              sp.z = sp.tz;
              const hit = sim.near(sp.x, sp.z, R);
              for (let k = 0; k < hit.length; k++) sim.damageEnemy(hit[k], s.dmg, 'sprite', 4, p.x, p.z);
              sim.events.push({ t: 'shoot', w: 'sprite', x: sp.x, z: sp.z });
              sp.st = 0;
              sp.cd = cd;
            } else {
              sp.x += (dx / d) * step;
              sp.z += (dz / d) * step;
            }
          }
          if (evo) {
            for (const b of sim.eprojs) {
              if (!b.alive) continue;
              const bx = b.x - sp.x, bz = b.z - sp.z;
              if (bx * bx + bz * bz < 1.7) b.alive = false;
            }
          }
        }
        break;
      }
      case 'sigil': {
        w.t -= dt;
        if (w.t <= 0) {
          w.t += cd;
          const n = s.count + st.amount;
          const R = s.area * st.area;
          // keep the field tidy: the oldest runes fade when too many are down
          let live = 0;
          for (const zn of sim.zones) if (zn.alive && zn.kind === 'sigil') live++;
          const cap = 6 + n * 3;
          for (let i = 0; i < sim.zones.length && live + n > cap; i++) {
            const zn = sim.zones[i];
            if (zn.alive && zn.kind === 'sigil' && zn.len === 0) {
              zn.alive = false;
              live--;
            }
          }
          const cands = sim.near(p.x, p.z, 11);
          for (let i = 0; i < n; i++) {
            let tx: number, tz: number;
            if (cands.length > 0 && sim.rng.next() < 0.7) {
              // in the path of something that is coming for you
              const c = cands[Math.floor(sim.rng.next() * cands.length)];
              const k = sim.rng.range(0.35, 0.8);
              tx = p.x + (c.x - p.x) * k + sim.rng.range(-1, 1);
              tz = p.z + (c.z - p.z) * k + sim.rng.range(-1, 1);
            } else {
              const a = sim.rng.angle(), d = sim.rng.range(2.5, 7);
              tx = p.x + Math.cos(a) * d;
              tz = p.z + Math.sin(a) * d;
            }
            zone(sim, 'sigil', tx, tz, R, s.dur * st.dur, s.dmg, 'sigil', evo);
          }
          sim.events.push({ t: 'shoot', w: 'sigil', x: p.x, z: p.z });
        }
        break;
      }
      case 'starfall': {
        w.t -= dt;
        if (w.t <= 0) {
          w.t += cd;
          const n = s.count + st.amount;
          const cands = sim.near(p.x, p.z, 17);
          const used = new Set<number>();
          for (let i = 0; i < n; i++) {
            let tx: number, tz: number;
            let pick: Enemy | null = null;
            for (let tries = 0; tries < 5 && cands.length > 0; tries++) {
              const c = cands[Math.floor(sim.rng.next() * cands.length)];
              if (!used.has(c.id) || tries === 4) {
                pick = c;
                break;
              }
            }
            if (pick) {
              used.add(pick.id);
              tx = pick.x;
              tz = pick.z;
            } else {
              const a = sim.rng.angle(), d = sim.rng.range(3, 11);
              tx = p.x + Math.cos(a) * d;
              tz = p.z + Math.sin(a) * d;
            }
            const zn = zone(sim, 'meteor', tx, tz, s.area * st.area, 0.55 + i * 0.09, s.dmg, 'starfall', evo);
            zn.len = s.dur * st.dur;
          }
          sim.events.push({ t: 'shoot', w: 'starfall', x: p.x, z: p.z });
        }
        break;
      }
      case 'lance': {
        w.t -= dt;
        if (w.t <= 0) {
          if (input.autoAim && !sim.nearest(p.x, p.z, 24)) {
            w.t = 0.15;
            break;
          }
          w.t += cd;
          if (w.t < 0) w.t = 0;
          const d = sim.aimDir(input, 24);
          const len = 24;
          const half = s.area * st.area;
          for (let dirI = 0; dirI < s.count; dirI++) {
            const sgn = dirI === 0 ? 1 : -1;
            const dx = d.x * sgn, dz = d.z * sgn;
            // sample circles along the beam and dedupe
            const seen = new Set<number>();
            const stepLen = Math.max(1.5, half * 1.4);
            for (let t = 0; t <= len; t += stepLen) {
              const list = sim.near(p.x + dx * t, p.z + dz * t, half);
              for (let k = 0; k < list.length; k++) {
                const e = list[k];
                if (seen.has(e.id)) continue;
                seen.add(e.id);
                sim.damageEnemy(e, s.dmg, 'lance', 5, p.x, p.z);
              }
            }
            sim.events.push({ t: 'beam', x: p.x, z: p.z, dx, dz, len, w: half });
          }
          sim.events.push({ t: 'shoot', w: 'lance', x: p.x, z: p.z });
        }
        break;
      }
      case 'frost': {
        w.t -= dt;
        if (w.t <= 0) {
          if (input.autoAim && !sim.nearest(p.x, p.z, 13)) {
            w.t = 0.15;
            break;
          }
          w.t += cd;
          if (w.t < 0) w.t = 0;
          const d = sim.aimDir(input, 13);
          const n = s.count + st.amount * 2;
          const base = Math.atan2(d.z, d.x);
          const cone = evo ? TAU : 0.95;
          const sp = s.speed * st.projSpeed;
          for (let i = 0; i < n; i++) {
            const f = evo ? i / n : n > 1 ? i / (n - 1) - 0.5 : 0;
            const a = base + f * cone + sim.rng.range(-0.04, 0.04);
            const v = sp * sim.rng.range(0.85, 1.1);
            spawnProj(sim, 'frost', 'frost', p.x + Math.cos(a) * 0.6, p.z + Math.sin(a) * 0.6, Math.cos(a) * v, Math.sin(a) * v, s.dur * st.dur, s.area, s.dmg, s.pierce, evo);
          }
          sim.events.push({ t: 'shoot', w: 'frost', x: p.x, z: p.z });
        }
        break;
      }
      case 'darts': {
        w.t -= dt;
        if (w.t <= 0) {
          if (!sim.nearest(p.x, p.z, 22)) {
            w.t = 0.15;
            break;
          }
          w.t += cd;
          if (w.t < 0) w.t = 0;
          const n = s.count + st.amount;
          const sp = s.speed * st.projSpeed;
          for (let i = 0; i < n; i++) {
            const a = p.aim + Math.PI + (i - (n - 1) / 2) * 0.55 + sim.rng.range(-0.2, 0.2);
            const pr = spawnProj(sim, 'dart', 'darts', p.x, p.z, Math.cos(a) * sp * 0.6, Math.sin(a) * sp * 0.6, s.dur * st.dur, s.area, s.dmg, s.pierce, evo);
            pr.spin = sp;
          }
          sim.events.push({ t: 'shoot', w: 'darts', x: p.x, z: p.z });
        }
        break;
      }
      case 'trail': {
        w.t -= dt;
        if (w.t <= 0) {
          w.t = cd;
          const R = s.area * st.area;
          // w.a / w.b remember the last patch position
          const moved = Math.hypot(p.x - w.a, p.z - w.b);
          if (moved > R * 0.75 || sim.time < 0.5) {
            w.a = p.x;
            w.b = p.z;
            zone(sim, 'fire', p.x, p.z, R, s.dur * st.dur, s.dmg, 'trail', evo);
          } else {
            // standing still keeps the newest patch alive instead of stacking
            for (let i = sim.zones.length - 1; i >= 0; i--) {
              const zn = sim.zones[i];
              if (zn.kind === 'fire' && zn.weapon === 'trail' && zn.alive) {
                zn.t = Math.min(zn.t, zn.dur * 0.5);
                break;
              }
            }
          }
        }
        break;
      }
      case 'aura': {
        w.t -= dt;
        if (w.t <= 0) {
          w.t += cd;
          const R = s.area * st.area;
          const list = sim.near(p.x, p.z, R);
          for (let k = 0; k < list.length; k++) {
            const e = list[k];
            sim.damageEnemy(e, s.dmg, 'aura', 1.2, p.x, p.z);
            if (evo) sim.chill(e, 0.8);
          }
          if (evo && list.length > 0) sim.heal(Math.min(1.2, list.length * 0.12), true);
        }
        break;
      }
      case 'glaive': {
        w.t -= dt;
        if (w.t <= 0) {
          if (input.autoAim && !sim.nearest(p.x, p.z, 20)) {
            w.t = 0.15;
            break;
          }
          w.t += cd;
          if (w.t < 0) w.t = 0;
          const d = sim.aimDir(input, 20);
          const n = s.count + st.amount;
          const base = Math.atan2(d.z, d.x);
          const sp = s.speed * st.projSpeed;
          for (let i = 0; i < n; i++) {
            const a = base + (i - (n - 1) / 2) * 0.5;
            const pr = spawnProj(sim, 'glaive', 'glaive', p.x, p.z, Math.cos(a) * sp, Math.sin(a) * sp, s.dur * st.dur * 2.4, s.area * Math.sqrt(st.area), s.dmg, 99, evo);
            pr.spin = s.dur * st.dur * 0.5; // outbound time
          }
          sim.events.push({ t: 'shoot', w: 'glaive', x: p.x, z: p.z });
        }
        break;
      }
    }
  }
}

function novaPulse(sim: Sim, R: number, dmg: number, burn: boolean) {
  const p = sim.player;
  const list = sim.near(p.x, p.z, R);
  for (let k = 0; k < list.length; k++) {
    const e = list[k];
    sim.damageEnemy(e, dmg, 'nova', 13, p.x, p.z);
    sim.burn(e, dmg * (burn ? 0.35 : 0.2), 3);
  }
  sim.events.push({ t: 'nova', x: p.x, z: p.z, r: R, c: 0xffa040 });
}

export function updateProjs(sim: Sim, dt: number) {
  const p = sim.player;
  const lim = sim.world.radius;
  for (let i = 0; i < sim.projs.length; i++) {
    const pr = sim.projs[i];
    if (!pr.alive) continue;
    pr.life -= dt;
    if (pr.life <= 0) {
      pr.alive = false;
      continue;
    }
    if (pr.kind === 'dart') {
      // homing: accelerate up to full speed and steer toward the target
      if (!pr.target || !pr.target.alive) pr.target = pr.maxLife - pr.life > 0.12 ? sim.nearest(pr.x, pr.z, 26) : null;
      const sp = pr.spin;
      let vl = Math.hypot(pr.vx, pr.vz) || 1;
      if (pr.target) {
        const dx = pr.target.x - pr.x, dz = pr.target.z - pr.z;
        const d = Math.hypot(dx, dz) || 1;
        const turn = Math.min(1, dt * 9);
        pr.vx += ((dx / d) * vl - pr.vx) * turn;
        pr.vz += ((dz / d) * vl - pr.vz) * turn;
      }
      vl = Math.hypot(pr.vx, pr.vz) || 1;
      const nv = Math.min(sp, vl + sp * 2.2 * dt);
      pr.vx = (pr.vx / vl) * nv;
      pr.vz = (pr.vz / vl) * nv;
    } else if (pr.kind === 'glaive') {
      const age = pr.maxLife - pr.life;
      if (pr.phase === 0) {
        if (age >= pr.spin) pr.phase = 1;
        else {
          const f = Math.exp(-1.6 * dt);
          pr.vx *= f;
          pr.vz *= f;
        }
      }
      if (pr.phase === 1) {
        const dx = p.x - pr.x, dz = p.z - pr.z;
        const d = Math.hypot(dx, dz) || 0.001;
        const sp = Math.min(40, 10 + (age - pr.spin) * 46);
        pr.vx = (dx / d) * sp;
        pr.vz = (dz / d) * sp;
        if (d < 1.2) {
          pr.alive = false;
          continue;
        }
      }
      if (pr.evolved) {
        for (const k of sim.pickups) {
          if (k.alive && !k.pull && k.kind !== 'chest') {
            const dx = k.x - pr.x, dz = k.z - pr.z;
            if (dx * dx + dz * dz < 16) k.pull = true;
          }
        }
      }
    }
    pr.x += pr.vx * dt;
    pr.z += pr.vz * dt;
    if (pr.x * pr.x + pr.z * pr.z > lim * lim) {
      pr.alive = false;
      continue;
    }
    const list = sim.near(pr.x, pr.z, pr.r);
    for (let k = 0; k < list.length; k++) {
      const e = list[k];
      if (pr.kind === 'glaive') {
        if (e.cdB > 0) continue;
        e.cdB = 0.3;
        sim.damageEnemy(e, pr.dmg, pr.weapon, 4, pr.x, pr.z);
        continue;
      }
      if (pr.hits.indexOf(e.id) >= 0) continue;
      pr.hits.push(e.id);
      const sx = pr.x - pr.vx * 0.05, sz = pr.z - pr.vz * 0.05;
      if (pr.kind === 'ember') {
        sim.damageEnemy(e, pr.dmg, pr.weapon, 4, sx, sz);
        sim.burn(e, pr.dmg * 0.15, 2);
        if (pr.evolved) sim.blasts.push({ x: pr.x, z: pr.z, r: 2.5 * Math.sqrt(sim.player.st.area), dmg: pr.dmg * 0.55, w: 'ember', kb: 4, burn: pr.dmg * 0.15, c: 0xff9a3c });
      } else if (pr.kind === 'frost') {
        sim.damageEnemy(e, pr.dmg, pr.weapon, 2.5, sx, sz);
        sim.chill(e, 2.4);
        if (pr.evolved && sim.rng.next() < 0.18) sim.freeze(e, 1.1);
      } else if (pr.kind === 'dart') {
        sim.damageEnemy(e, pr.dmg, pr.weapon, 3, sx, sz);
        pr.target = null;
      }
      pr.pierce--;
      if (pr.pierce < 0 || (pr.kind !== 'dart' && pr.pierce <= 0)) {
        pr.alive = false;
        break;
      }
    }
  }
}

export function updateEProjs(sim: Sim, dt: number) {
  const p = sim.player;
  for (let i = 0; i < sim.eprojs.length; i++) {
    const b = sim.eprojs[i];
    if (!b.alive) continue;
    b.life -= dt;
    if (b.life <= 0) {
      b.alive = false;
      continue;
    }
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    const dx = p.x - b.x, dz = p.z - b.z;
    const rr = b.r + 0.45;
    if (dx * dx + dz * dz < rr * rr) {
      if (sim.hurtPlayer(b.dmg, b.x, b.z)) b.alive = false;
      else if (p.dashT <= 0 && p.iframe <= 0) b.alive = false;
    }
  }
}

export function updateZones(sim: Sim, dt: number) {
  const p = sim.player;
  for (let i = 0; i < sim.zones.length; i++) {
    const z = sim.zones[i];
    if (!z.alive) continue;
    z.t += dt;
    switch (z.kind) {
      case 'fire':
      case 'crater': {
        z.tick -= dt;
        if (z.tick <= 0) {
          z.tick = 0.4;
          const list = sim.near(z.x, z.z, z.r);
          for (let k = 0; k < list.length; k++) {
            sim.damageEnemy(list[k], z.dmg, z.weapon, 0, 0, 0);
            sim.burn(list[k], z.dmg * 0.25, 1.5);
          }
        }
        if (z.t >= z.dur) {
          z.alive = false;
          if (z.kind === 'fire' && z.evolved) {
            sim.blasts.push({ x: z.x, z: z.z, r: z.r * 1.4, dmg: z.dmg * 2.5, w: z.weapon, kb: 6, burn: z.dmg * 0.3, c: 0xff6a2a });
          }
        }
        break;
      }
      case 'sigil': {
        // len > 0: the echo burst of an evolved rune is counting down
        if (z.len > 0) {
          z.len -= dt;
          if (z.len <= 0) {
            z.alive = false;
            sim.blasts.push({ x: z.x, z: z.z, r: z.r * 1.15, dmg: z.dmg * 0.7, w: z.weapon, kb: 6, burn: 0, c: 0xffd76a });
          }
          break;
        }
        let trip = z.t >= z.dur;
        if (!trip && z.t > 0.45) {
          z.tick -= dt;
          if (z.tick <= 0) {
            z.tick = 0.08;
            trip = sim.near(z.x, z.z, z.r * 0.4).length > 0;
          }
        }
        if (trip) {
          sim.blasts.push({ x: z.x, z: z.z, r: z.r, dmg: z.dmg, w: z.weapon, kb: 11, burn: 0, c: 0xc9a2ff });
          if (z.evolved) z.len = 0.45;
          else z.alive = false;
        }
        break;
      }
      case 'meteor': {
        if (z.t >= z.dur) {
          z.alive = false;
          sim.blasts.push({ x: z.x, z: z.z, r: z.r, dmg: z.dmg, w: z.weapon, kb: 9, burn: z.dmg * 0.08, c: 0xffe08a });
          if (z.evolved) {
            const c = zone(sim, 'crater', z.x, z.z, z.r * 0.9, z.len > 0 ? z.len : 2.5, z.dmg * 0.12, z.weapon, false);
            c.tick = 0.4;
          }
        }
        break;
      }
      case 'slam': {
        if (z.t >= z.dur) {
          z.alive = false;
          sim.events.push({ t: 'explode', x: z.x, z: z.z, r: z.r, c: 0xb04aff, hostile: true });
          const dx = p.x - z.x, dz = p.z - z.z;
          if (dx * dx + dz * dz < (z.r + 0.3) * (z.r + 0.3)) sim.hurtPlayer(z.dmg, z.x, z.z);
        }
        break;
      }
      case 'charge': {
        if (z.t >= z.dur) z.alive = false;
        break;
      }
      case 'vent': {
        // lava vent: scorches everything standing on it, friend or foe
        if (z.t >= z.dur) {
          z.alive = false;
          sim.events.push({ t: 'explode', x: z.x, z: z.z, r: z.r, c: 0xff6a2a, hostile: true });
          const I = sim.intensity();
          const list = sim.near(z.x, z.z, z.r);
          for (let k = 0; k < list.length; k++) {
            const e = list[k];
            sim.applyDamage(e, (60 + 14 * I) * (e.boss ? 0.5 : 1), null, false, 8, z.x, z.z);
            sim.burn(e, 8 + 2 * I, 3);
          }
          const dx = p.x - z.x, dz = p.z - z.z;
          if (dx * dx + dz * dz < (z.r + 0.3) * (z.r + 0.3)) sim.hurtPlayer(z.dmg, z.x, z.z);
        }
        break;
      }
      case 'spore': {
        // spore bloom: bursts into a cloud that lingers and eats at everything inside it
        if (z.len > 0) {
          z.len -= dt;
          z.tick -= dt;
          if (z.tick <= 0) {
            z.tick = 0.5;
            const I = sim.intensity();
            const list = sim.near(z.x, z.z, z.r);
            for (let k = 0; k < list.length; k++) {
              const e = list[k];
              sim.applyDamage(e, (7 + 2 * I) * (e.boss ? 0.5 : 1), null, false, 0, 0, 0, true);
              if (e.alive) sim.chill(e, 0.8);
            }
            const dx = p.x - z.x, dz = p.z - z.z;
            if (dx * dx + dz * dz < z.r * z.r) sim.hurtPlayer(z.dmg, p.x, p.z);
          }
          if (z.len <= 0) z.alive = false;
          break;
        }
        if (z.t >= z.dur) {
          // dx carries a custom cloud lifetime (sporecap puffs are shorter than the region's blooms)
          z.len = z.dx > 0 ? z.dx : 5;
          z.tick = 0;
          sim.events.push({ t: 'explode', x: z.x, z: z.z, r: z.r, c: 0x8cff6a, hostile: true });
        }
        break;
      }
      case 'frost': {
        // frost burst: freezes the horde, numbs the bearer
        if (z.t >= z.dur) {
          z.alive = false;
          sim.events.push({ t: 'explode', x: z.x, z: z.z, r: z.r, c: 0x9fe3ff, hostile: true });
          const list = sim.near(z.x, z.z, z.r);
          for (let k = 0; k < list.length; k++) {
            const e = list[k];
            sim.applyDamage(e, 12 + 3 * sim.intensity(), null, false, 0, 0, 0);
            sim.freeze(e, 2.2);
            sim.chill(e, 4);
          }
          const dx = p.x - z.x, dz = p.z - z.z;
          if (dx * dx + dz * dz < (z.r + 0.3) * (z.r + 0.3)) {
            if (sim.hurtPlayer(z.dmg, z.x, z.z)) p.slowT = 2.4;
          }
        }
        break;
      }
    }
  }
}
