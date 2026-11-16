import * as THREE from 'three';
import { RNG } from '../core/rng';
import type { Obstacle, World } from '../sim/worldgen';
import type { Palette } from './env';
import { makeWorldMat } from './materials';
import * as G from './geo';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();

export interface PropsResult {
  group: THREE.Group;
  dispose(): void;
}

/** Build every static prop (trees, rocks, ruins, grass...) as instanced meshes. */
export function buildProps(world: World, pal: Palette, opts: { shadows: boolean; decorDensity: number }): PropsResult {
  const group = new THREE.Group();
  const rng = new RNG(world.seed + 99);
  const matSway = makeWorldMat({ sway: true, cutout: true });
  const matStatic = makeWorldMat({ cutout: true });
  const matDecor = makeWorldMat({ sway: true, side: THREE.DoubleSide, smooth: true });
  const geos: THREE.BufferGeometry[] = [];
  const meshes: THREE.InstancedMesh[] = [];

  const variants = (f: (v: number) => THREE.BufferGeometry) => [0, 1, 2, 3].map(f);
  const lib: Record<string, { geos: THREE.BufferGeometry[]; sway: boolean; sink: number }> = {
    pine: { geos: [G.geoPine(pal.leafA, pal.leafB, pal.trunk, pal.snow)], sway: true, sink: 0.15 },
    oak: { geos: [G.geoOak(pal.oakA, pal.oakB, pal.trunk)], sway: true, sink: 0.15 },
    dead: { geos: [G.geoDeadTree(pal.trunk)], sway: true, sink: 0.15 },
    rock: { geos: variants((v) => G.geoRock(pal.rock, v, v >= 2 ? pal.moss : 0)), sway: false, sink: 0.2 },
    pillar: { geos: variants((v) => G.geoPillar(pal.stone, v)), sway: false, sink: 0.12 },
    wall: { geos: variants((v) => G.geoWall(pal.stone, v)), sway: false, sink: 0.15 },
    crystal: { geos: variants((v) => G.geoCrystal(pal.crystal, v)), sway: false, sink: 0.1 },
    stump: { geos: [G.geoStump(pal.trunk)], sway: false, sink: 0.08 },
    shroom: { geos: [G.geoBigShroom(0xd8cfc0, pal.shroomCap, pal.shroomGlow)], sway: true, sink: 0.05 },
    ice: { geos: variants((v) => G.geoIce(pal.ice, v)), sway: false, sink: 0.2 },
    cactus: { geos: [G.geoCactus(pal.cactus, pal.flowers[0])], sway: false, sink: 0.1 },
    bone: { geos: [G.geoBone(pal.bone)], sway: false, sink: 0.25 },
  };

  // bucket obstacles by kind+variant
  const buckets = new Map<string, Obstacle[]>();
  for (const o of world.obstacles) {
    const def = lib[o.kind];
    const v = o.variant % def.geos.length;
    const key = o.kind + ':' + v;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(o);
  }
  for (const [key, list] of buckets) {
    const [kind, vs] = key.split(':');
    const def = lib[kind];
    const geo = def.geos[Number(vs)];
    const mesh = new THREE.InstancedMesh(geo, def.sway ? matSway : matStatic, list.length);
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const y = world.height(o.x, o.z) - def.sink * o.s;
      _p.set(o.x, y, o.z);
      _q.setFromAxisAngle(_up, o.rot);
      const sy = o.s * (kind === 'pine' || kind === 'oak' ? rng.range(0.9, 1.25) : 1);
      _s.set(o.s, sy, o.s);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      const k = rng.range(0.82, 1.12);
      _c.setRGB(k * rng.range(0.94, 1.06), k, k * rng.range(0.94, 1.06));
      mesh.setColorAt(i, _c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = opts.shadows;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push(mesh);
  }
  for (const k in lib) geos.push(...lib[k].geos);

  // decor
  const decorGeos = [G.geoGrassTuft(pal.grassBlade), G.geoFlower(pal.fern), G.geoSmallShroom(), G.geoPebble(pal.rock), G.geoFern(pal.fern)];
  geos.push(...decorGeos);
  const dBuckets: number[][] = [[], [], [], [], []];
  world.decor.forEach((d, i) => {
    // grass density scales with the quality setting; rarer decor always stays
    if (d.kind === 0 && d.tint > opts.decorDensity) return;
    dBuckets[d.kind].push(i);
  });
  const shroomGlow = new THREE.Color(pal.shroomGlow);
  for (let k = 0; k < 5; k++) {
    const list = dBuckets[k];
    if (list.length === 0) continue;
    const mesh = new THREE.InstancedMesh(decorGeos[k], k === 3 ? matStatic : matDecor, list.length);
    for (let i = 0; i < list.length; i++) {
      const d = world.decor[list[i]];
      const y = world.height(d.x, d.z) - 0.03;
      _p.set(d.x, y, d.z);
      _q.setFromAxisAngle(_up, d.rot);
      const s = d.s * (k === 0 ? 1.25 : 1);
      _s.set(s, s * (k === 0 ? 0.8 + d.tint * 0.7 : 1), s);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      if (k === 1) _c.setHex(pal.flowers[Math.floor(d.tint * pal.flowers.length) % pal.flowers.length]);
      else if (k === 2) _c.copy(shroomGlow).multiplyScalar(0.8 + d.tint * 0.4);
      else {
        const b = 0.78 + d.tint * 0.4;
        _c.setRGB(b * (0.95 + d.tint * 0.15), b, b * (1.05 - d.tint * 0.15));
      }
      mesh.setColorAt(i, _c);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = k !== 1 && k !== 2;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes.push(mesh);
  }

  // beacon towers + the hearth at the centre
  const beaconGeo = G.geoBeacon(pal.stone, pal.stoneDark);
  geos.push(beaconGeo);
  const bm = new THREE.InstancedMesh(beaconGeo, matStatic, world.beacons.length);
  world.beacons.forEach((b, i) => {
    _p.set(b.x, world.height(b.x, b.z) - 0.1, b.z);
    _q.setFromAxisAngle(_up, i * 0.7);
    _s.set(1, 1, 1);
    _m.compose(_p, _q, _s);
    bm.setMatrixAt(i, _m);
    bm.setColorAt(i, _c.setRGB(1, 1, 1));
  });
  bm.castShadow = opts.shadows;
  bm.receiveShadow = true;
  bm.frustumCulled = false;
  group.add(bm);
  meshes.push(bm);

  const hearthGeo = G.geoHearth(pal.stone, pal.trunk);
  geos.push(hearthGeo);
  const hearth = new THREE.Mesh(hearthGeo, matStatic);
  hearth.position.set(0, world.height(0, 0) - 0.05, 0);
  hearth.castShadow = opts.shadows;
  hearth.receiveShadow = true;
  group.add(hearth);

  return {
    group,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of meshes) m.dispose();
      matSway.dispose();
      matStatic.dispose();
      matDecor.dispose();
    },
  };
}
