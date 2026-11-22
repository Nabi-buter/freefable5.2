import * as THREE from 'three';
import type { CharDef, EnemyKind } from '../sim/defs';
import { ENEMY_KINDS } from '../sim/defs';
import type { Enemy, Player } from '../sim/types';
import { makeWorldMat } from './materials';
import * as G from './geo';
import { damp } from '../core/rng';

export interface HeightFn {
  (x: number, z: number): number;
}

// =====================================================================================
// Player
// =====================================================================================
export class PlayerModel {
  readonly root = new THREE.Group();
  readonly lanternLight: THREE.PointLight;
  private tilt = new THREE.Group();
  private body: THREE.Mesh;
  private head: THREE.Mesh;
  private armL: THREE.Mesh;
  private armR: THREE.Mesh;
  private legL: THREE.Mesh;
  private legR: THREE.Mesh;
  private lantern: THREE.Mesh;
  private mat: THREE.MeshLambertMaterial;
  private geos: THREE.BufferGeometry[];
  private phase = 0;
  private yaw = 0;
  private speedS = 0;
  private dead = 0;
  readonly accent: THREE.Color;
  /** world position of the lantern, for particles */
  readonly lanternPos = new THREE.Vector3();

  constructor(char: CharDef, shadows: boolean) {
    const g = G.geoPlayer(char.cloak, char.accent);
    this.geos = [g.body, g.head, g.arm, g.leg, g.lantern];
    this.accent = new THREE.Color(char.accent);
    this.mat = makeWorldMat({ sway: true });
    const mk = (geo: THREE.BufferGeometry) => {
      const m = new THREE.Mesh(geo, this.mat);
      m.castShadow = shadows;
      return m;
    };
    this.body = mk(g.body);
    this.head = mk(g.head);
    this.head.position.set(0, 1.36, 0);
    this.armL = mk(g.arm);
    this.armL.position.set(0, 1.24, 0.34);
    this.armR = mk(g.arm);
    this.armR.position.set(0, 1.24, -0.34);
    this.legL = mk(g.leg);
    this.legL.position.set(0, 0.47, 0.15);
    this.legR = mk(g.leg);
    this.legR.position.set(0, 0.47, -0.15);
    this.lantern = mk(g.lantern);
    this.lantern.castShadow = false;
    this.tilt.add(this.body, this.head, this.armL, this.armR, this.legL, this.legR);
    this.root.add(this.tilt, this.lantern);
    this.lanternLight = new THREE.PointLight(char.accent, 30, 30, 1.6);
    this.root.add(this.lanternLight);
  }

  update(p: Player, dt: number, time: number, h: number) {
    const speed = Math.hypot(p.vx, p.vz);
    this.speedS = damp(this.speedS, speed, 10, dt);
    const run = Math.min(1, this.speedS / 6);
    this.phase += dt * (4 + this.speedS * 1.5);
    // face the aim direction (model faces +X)
    const target = -p.aim;
    let da = target - this.yaw;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    this.yaw += da * (1 - Math.exp(-16 * dt));
    this.root.position.set(p.x, h, p.z);
    this.root.rotation.y = this.yaw;
    const sw = Math.sin(this.phase);
    const dashing = p.dashT > 0;
    if (!p.alive) {
      this.dead = Math.min(1, this.dead + dt * 2.2);
      this.tilt.rotation.z = -this.dead * 1.45;
      this.tilt.position.y = -this.dead * 0.25;
      this.lantern.position.y = Math.max(0.2, this.lantern.position.y - dt * 3);
      this.lanternLight.intensity = damp(this.lanternLight.intensity, 4, 2, dt);
      this.lantern.getWorldPosition(this.lanternPos);
      return;
    }
    this.dead = 0;
    // lean into movement relative to facing
    const fx = Math.cos(p.aim), fz = Math.sin(p.aim);
    const fwd = (p.vx * fx + p.vz * fz) / 8;
    const side = (-p.vx * fz + p.vz * fx) / 8;
    this.tilt.rotation.z = damp(this.tilt.rotation.z, -fwd * 0.28 - (dashing ? 0.25 : 0), 12, dt);
    this.tilt.rotation.x = damp(this.tilt.rotation.x, side * 0.25, 12, dt);
    this.tilt.position.y = Math.abs(sw) * 0.07 * run + Math.sin(time * 2) * 0.012;
    const stretch = dashing ? 1.25 : 1;
    this.tilt.scale.set(stretch, 1 / Math.sqrt(stretch), 1);
    this.legL.rotation.z = sw * 0.85 * run;
    this.legR.rotation.z = -sw * 0.85 * run;
    this.armL.rotation.z = -sw * 0.6 * run + 0.1;
    this.armL.rotation.x = 0.12;
    // right arm holds the lantern out
    this.armR.rotation.z = 0.95 + Math.sin(time * 1.7) * 0.04;
    this.armR.rotation.x = -0.25;
    this.head.rotation.y = Math.sin(time * 0.7) * 0.06;
    this.head.position.y = 1.36 + Math.sin(time * 2 + 1) * 0.008;
    // lantern hangs in front of the right hand with a lazy swing
    const lx = 0.5, lz = -0.52;
    this.lantern.position.set(lx + Math.sin(time * 2.3) * 0.03, 1.0 + Math.sin(time * 1.9) * 0.03 + Math.abs(sw) * 0.04 * run, lz);
    this.lantern.rotation.z = Math.sin(this.phase * 0.5) * 0.18 * run + Math.sin(time * 1.3) * 0.06;
    const flick = 1 + Math.sin(time * 13.1) * 0.035 + Math.sin(time * 7.3 + 1.7) * 0.05;
    const hpFrac = p.hp / p.st.maxHp;
    this.lanternLight.position.set(lx, 1.9, lz);
    this.lanternLight.intensity = (22 + hpFrac * 14) * flick;
    // i-frame blink + hurt flash
    const blink = p.iframe > 0 && p.dashT <= 0 && Math.sin(time * 40) > 0.2;
    this.tilt.visible = !blink || p.hurtT <= 0;
    const e = p.hurtT > 0 ? p.hurtT / 0.35 : 0;
    this.mat.emissive.setRGB(e * 0.9, e * 0.15, e * 0.1);
    this.lantern.getWorldPosition(this.lanternPos);
  }

  /** idle pose for menus */
  idle(time: number, x: number, h: number, z: number, yaw: number) {
    this.root.position.set(x, h, z);
    this.root.rotation.y = yaw;
    this.tilt.rotation.set(0, 0, 0);
    this.tilt.position.y = Math.sin(time * 2) * 0.015;
    this.tilt.scale.set(1, 1, 1);
    this.tilt.visible = true;
    this.legL.rotation.z = 0;
    this.legR.rotation.z = 0;
    this.armL.rotation.set(0.12, 0, 0.1);
    this.armR.rotation.set(-0.25, 0, 0.95 + Math.sin(time * 1.7) * 0.04);
    this.head.rotation.y = Math.sin(time * 0.5) * 0.25;
    this.lantern.position.set(0.5 + Math.sin(time * 2.3) * 0.02, 1.0 + Math.sin(time * 1.9) * 0.03, -0.52);
    this.lantern.rotation.z = Math.sin(time * 1.3) * 0.08;
    const flick = 1 + Math.sin(time * 13.1) * 0.035 + Math.sin(time * 7.3 + 1.7) * 0.05;
    this.lanternLight.position.set(0.5, 1.9, -0.52);
    this.lanternLight.intensity = 34 * flick;
    this.mat.emissive.setRGB(0, 0, 0);
    this.lantern.getWorldPosition(this.lanternPos);
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    this.mat.dispose();
  }
}

// =====================================================================================
// Enemies — one InstancedMesh per kind
// =====================================================================================
interface KindRender {
  mesh: THREE.InstancedMesh;
  fx: THREE.InstancedBufferAttribute;
  phase: THREE.InstancedBufferAttribute;
  n: number;
  cap: number;
}

const CAPS: Record<EnemyKind, number> = { shade: 460, skitter: 460, brute: 200, spitter: 200, wraith: 220, bomber: 220, husk: 200, rime: 160, worm: 160, sporecap: 180, thief: 40, herald: 4, eclipse: 2 };
/** colour of each kind's glow, used for death sparks */
export const KIND_COLOR: Record<EnemyKind, [number, number, number]> = {
  shade: [1.0, 0.25, 0.5], skitter: [0.6, 1.0, 0.35], brute: [1.0, 0.55, 0.15], spitter: [0.65, 1.0, 0.25], wraith: [0.4, 0.95, 1.0],
  bomber: [1.0, 0.25, 0.4], husk: [1.0, 0.82, 0.3], rime: [0.55, 0.92, 1.0], worm: [1.0, 0.5, 0.18], sporecap: [0.6, 1.0, 0.55], thief: [1.0, 0.75, 0.3], herald: [0.7, 0.3, 1.0], eclipse: [1.0, 0.4, 0.2],
};

const BOSS_TINT: Record<string, [number, number, number]> = {
  frostmere: [0.5, 0.85, 1.45],
  emberwaste: [1.5, 0.7, 0.4],
  gloommire: [0.65, 1.35, 0.7],
  stormcrag: [0.8, 0.95, 1.4],
};

export class EnemyRenderer {
  readonly group = new THREE.Group();
  private kinds = {} as Record<EnemyKind, KindRender>;
  private mat: THREE.MeshLambertMaterial;
  private geos: THREE.BufferGeometry[] = [];
  /** elites / bosses visible this frame, for overlay health bars */
  readonly marked: Enemy[] = [];
  /** burrowed enemies near the camera: drawn as moving dust by the view */
  readonly buried: Enemy[] = [];
  /** enemies that just died: they sink and burn away over a fraction of a second */
  private corpses: { kind: EnemyKind; x: number; z: number; face: number; scale: number; t0: number }[] = [];
  private now = 0;

  /** leave a short-lived dissolving body where an enemy fell */
  addCorpse(kind: EnemyKind, x: number, z: number, face: number, scale: number) {
    if (kind === 'herald' || kind === 'eclipse' || scale <= 0) return;
    if (this.corpses.length >= 140) this.corpses.shift();
    this.corpses.push({ kind, x, z, face, scale, t0: this.now });
  }

  clearCorpses() {
    this.corpses.length = 0;
  }

  constructor(shadows: boolean, biome = 'ashwood') {
    this.mat = makeWorldMat({ instFx: true });
    const builders: Record<EnemyKind, () => THREE.BufferGeometry> = {
      shade: G.geoShade, skitter: G.geoSkitter, brute: G.geoBrute, spitter: G.geoSpitter, wraith: G.geoWraith,
      bomber: G.geoBomber, husk: G.geoHusk, rime: G.geoRime, worm: G.geoWorm, sporecap: G.geoSporecap, thief: G.geoThief, herald: G.geoHerald, eclipse: G.geoEclipse,
    };
    for (const kind of ENEMY_KINDS) {
      const geo = builders[kind]();
      this.geos.push(geo);
      const cap = CAPS[kind];
      const fx = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      const phase = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      fx.setUsage(THREE.DynamicDrawUsage);
      phase.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aFx', fx);
      geo.setAttribute('aPhase', phase);
      const mesh = new THREE.InstancedMesh(geo, this.mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = shadows;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      this.kinds[kind] = { mesh, fx, phase, n: 0, cap };
      // the herald and the Eclipse take on the colour of the island they rule
      const tint = BOSS_TINT[biome];
      if (tint && (kind === 'herald' || kind === 'eclipse')) {
        const col = new THREE.Color(tint[0], tint[1], tint[2]);
        for (let i = 0; i < cap; i++) mesh.setColorAt(i, col);
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  update(lists: Enemy[][], height: HeightFn, cx: number, cz: number, time: number) {
    for (const k of ENEMY_KINDS) this.kinds[k].n = 0;
    this.marked.length = 0;
    this.buried.length = 0;
    this.now = time;
    const R2 = 62 * 62;
    for (const list of lists) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e.alive) continue;
        const dx = e.x - cx, dz = e.z - cz;
        if (dx * dx + dz * dz > R2) continue;
        if (e.buried) {
          this.buried.push(e);
          continue;
        }
        const kr = this.kinds[e.kind];
        if (kr.n >= kr.cap) continue;
        const idx = kr.n++;
        if (e.elite || e.boss) this.marked.push(e);
        // --- pose
        let y = height(e.x, e.z);
        let sx = e.scale, sy = e.scale, sz = e.scale;
        const ph = e.t * (2.2 + e.speed * 1.25) + e.seed * 20;
        const frozen = e.freezeT > 0;
        const tp = frozen ? e.seed * 20 : ph;
        switch (e.kind) {
          case 'shade':
            y += 0.12 + Math.sin(tp * 0.8) * 0.1;
            break;
          case 'skitter':
            break;
          case 'brute': {
            const st = Math.abs(Math.sin(tp * 0.9));
            y += st * 0.14;
            sy *= 1 - (1 - st) * 0.06;
            break;
          }
          case 'spitter':
            if (e.tele) {
              sy *= 1.12;
              sx *= 0.94;
              sz *= 0.94;
            }
            break;
          case 'wraith':
            y += 0.2 + Math.sin(tp * 0.6) * 0.08;
            if (e.st === 2) {
              sx *= 1.45;
              sy *= 0.85;
            } else if (e.st === 1) {
              sx *= 0.85;
              sy *= 1.12;
            }
            break;
          case 'bomber': {
            const b = Math.abs(Math.sin(tp * 1.1));
            y += b * 0.32;
            if (e.tele) {
              const pulse = 1.15 + Math.sin(time * 40) * 0.12 + e.stT * 0.5;
              sx *= pulse;
              sy *= pulse;
              sz *= pulse;
            }
            break;
          }
          case 'husk':
            y += Math.abs(Math.sin(tp * 0.9)) * 0.08;
            break;
          case 'sporecap': {
            y += Math.abs(Math.sin(tp * 0.9)) * 0.12;
            if (e.tele) {
              const sw = 1.18 + Math.sin(time * 26) * 0.06;
              sx *= sw;
              sz *= sw;
              sy *= 0.9;
            }
            break;
          }
          case 'rime': {
            const st = Math.abs(Math.sin(tp * 0.8));
            y += st * 0.1;
            break;
          }
          case 'worm':
            if (e.tele) {
              sx *= 1.08;
              sz *= 1.08;
            }
            break;
          case 'herald':
            y += Math.sin(time * 1.6) * 0.1;
            if (e.tele) sy *= 1.08;
            break;
          case 'eclipse':
            y += 0.4 + Math.sin(time * 1.1) * 0.35;
            break;
        }
        // spawn: rise out of the ground with a little overshoot
        if (e.spawn < 1) {
          const s = e.spawn;
          const k = s < 0.8 ? (s / 0.8) * 1.1 : 1.1 - ((s - 0.8) / 0.2) * 0.1;
          sy *= k;
          const w = 0.55 + 0.45 * s;
          sx *= w;
          sz *= w;
        }
        if (e.flash > 0.3 && !e.boss) {
          const k = 1 + e.flash * 0.1;
          sx *= k;
          sz *= k;
          sy *= 2 - k;
        }
        const yaw = -e.face;
        const c = Math.cos(yaw), s = Math.sin(yaw);
        const m = kr.mesh.instanceMatrix.array as Float32Array;
        const o = idx * 16;
        m[o] = c * sx; m[o + 1] = 0; m[o + 2] = -s * sx; m[o + 3] = 0;
        m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
        m[o + 8] = s * sz; m[o + 9] = 0; m[o + 10] = c * sz; m[o + 11] = 0;
        m[o + 12] = e.x; m[o + 13] = y; m[o + 14] = e.z; m[o + 15] = 1;
        const f = kr.fx.array as Float32Array;
        f[idx * 4] = e.boss ? e.flash * 0.22 : e.flash * 0.75;
        f[idx * 4 + 1] = e.tele ? (e.kind === 'eclipse' ? 0.22 : e.kind === 'sporecap' ? 0.28 + 0.12 * Math.sin(time * 30) : 0.6 + 0.4 * Math.sin(time * 30)) : 0;
        f[idx * 4 + 2] = frozen ? 1 : e.chillT > 0 ? 0.45 : 0;
        f[idx * 4 + 3] = e.elite ? 1 : 0;
        (kr.phase.array as Float32Array)[idx] = tp;
      }
    }
    // --- dissolving bodies
    const DUR = 0.45;
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      const k = (time - c.t0) / DUR;
      if (k >= 1 || k < 0) {
        this.corpses.splice(i, 1);
        continue;
      }
      const kr = this.kinds[c.kind];
      if (kr.n >= kr.cap) continue;
      const dx = c.x - cx, dz = c.z - cz;
      if (dx * dx + dz * dz > R2) continue;
      const idx = kr.n++;
      const sy = c.scale * (1 - k * 0.45), sxz = c.scale * (1 + k * 0.18);
      const yaw = -c.face;
      const cs = Math.cos(yaw), sn = Math.sin(yaw);
      const m = kr.mesh.instanceMatrix.array as Float32Array;
      const o = idx * 16;
      m[o] = cs * sxz; m[o + 1] = 0; m[o + 2] = -sn * sxz; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = sn * sxz; m[o + 9] = 0; m[o + 10] = cs * sxz; m[o + 11] = 0;
      m[o + 12] = c.x; m[o + 13] = height(c.x, c.z) - k * 0.15; m[o + 14] = c.z; m[o + 15] = 1;
      const f = kr.fx.array as Float32Array;
      f[idx * 4] = (1 - k) * 0.55;
      f[idx * 4 + 1] = 0;
      f[idx * 4 + 2] = 0;
      f[idx * 4 + 3] = 2 + k;
      (kr.phase.array as Float32Array)[idx] = 0;
    }
    for (const k of ENEMY_KINDS) {
      const kr = this.kinds[k];
      kr.mesh.count = kr.n;
      if (kr.n > 0) {
        kr.mesh.instanceMatrix.needsUpdate = true;
        kr.fx.needsUpdate = true;
        kr.phase.needsUpdate = true;
      }
    }
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    for (const k of ENEMY_KINDS) this.kinds[k].mesh.dispose();
    this.mat.dispose();
  }
}
