import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RNG } from '../core/rng';

type V3 = [number, number, number];
export interface PartOpts {
  pos?: V3;
  rot?: V3;
  scl?: V3 | number;
  glow?: number;
  /** wind/wobble weight; may depend on the transformed vertex position */
  sway?: number | ((x: number, y: number, z: number) => number);
  /** random per-face brightness variation */
  jitter?: number;
  /** vertical gradient: multiply colour by lerp(g0,g1,y01) */
  grad?: [number, number];
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const jrng = new RNG(1337);

/** Prepare a primitive as a mergeable, non-indexed part with colour/glow/sway attributes. */
export function part(g: THREE.BufferGeometry, color: number, o: PartOpts = {}): THREE.BufferGeometry {
  let geo = g.index ? g.toNonIndexed() : g;
  if (geo === g) geo = g.clone();
  geo.deleteAttribute('uv');
  const scl = o.scl === undefined ? [1, 1, 1] : typeof o.scl === 'number' ? [o.scl, o.scl, o.scl] : o.scl;
  _p.set(...(o.pos ?? [0, 0, 0]));
  _e.set(...(o.rot ?? [0, 0, 0]));
  _q.setFromEuler(_e);
  _s.set(scl[0], scl[1], scl[2]);
  _m.compose(_p, _q, _s);
  geo.applyMatrix4(_m);
  const pos = geo.getAttribute('position');
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const glow = new Float32Array(n);
  const sway = new Float32Array(n);
  _c.setHex(color);
  let minY = Infinity, maxY = -Infinity;
  if (o.grad) {
    for (let i = 0; i < n; i++) {
      const y = pos.getY(i);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  let faceJ = 1;
  for (let i = 0; i < n; i++) {
    if (o.jitter && i % 3 === 0) faceJ = 1 + (jrng.next() - 0.5) * 2 * o.jitter;
    let k = o.jitter ? faceJ : 1;
    if (o.grad) {
      const t = maxY > minY ? (pos.getY(i) - minY) / (maxY - minY) : 0;
      k *= o.grad[0] + (o.grad[1] - o.grad[0]) * t;
    }
    col[i * 3] = _c.r * k;
    col[i * 3 + 1] = _c.g * k;
    col[i * 3 + 2] = _c.b * k;
    glow[i] = o.glow ?? 0;
    sway[i] = typeof o.sway === 'function' ? o.sway(pos.getX(i), pos.getY(i), pos.getZ(i)) : (o.sway ?? 0);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(glow, 1));
  geo.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  return geo;
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const sph = (r: number, ws = 8, hs = 6) => new THREE.SphereGeometry(r, ws, hs);
const ico = (r: number, d = 0) => new THREE.IcosahedronGeometry(r, d);
const oct = (r: number) => new THREE.OctahedronGeometry(r, 0);
const cyl = (rt: number, rb: number, h: number, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
const cone = (r: number, h: number, seg = 8) => new THREE.ConeGeometry(r, h, seg);
const torus = (r: number, t: number, rs = 6, ts = 14) => new THREE.TorusGeometry(r, t, rs, ts);
const HP = Math.PI / 2;

/** deform a geometry's vertices with a deterministic lumpy noise so rocks/canopies look hand-cut */
function lumpy(g: THREE.BufferGeometry, amt: number, seed: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // hash by quantised position so shared corners move together
    const h = Math.sin(Math.round(x * 31) * 12.9898 + Math.round(y * 31) * 78.233 + Math.round(z * 31) * 37.719 + seed * 9.17) * 43758.5453;
    const f = 1 + ((h - Math.floor(h)) - 0.5) * 2 * amt;
    pos.setXYZ(i, x * f, y * f, z * f);
  }
  g.computeVertexNormals();
  return g;
}

// =====================================================================================
// ENEMIES — all models face +X, feet at y=0
// =====================================================================================
export function geoShade(): THREE.BufferGeometry {
  const body = 0x241a3d, dark = 0x130d24, eye = 0xff3d7a;
  const tail = (x: number, y: number) => Math.max(0, 0.9 - y) * 1.1;
  return merge([
    part(sph(0.5, 8, 6), body, { pos: [0, 1.0, 0], scl: [1, 1.12, 1], jitter: 0.12 }),
    part(cone(0.49, 1.0, 8), dark, { pos: [0, 0.48, 0], rot: [Math.PI, 0, 0], sway: tail, jitter: 0.1 }),
    part(cone(0.16, 0.5, 5), dark, { pos: [0.18, 0.75, 0.48], rot: [0.5, 0, -0.5], sway: 0.5 }),
    part(cone(0.16, 0.5, 5), dark, { pos: [0.18, 0.75, -0.48], rot: [-0.5, 0, -0.5], sway: 0.5 }),
    part(sph(0.1, 6, 4), eye, { pos: [0.4, 1.1, 0.18], glow: 2.6, scl: [0.7, 1.3, 1] }),
    part(sph(0.1, 6, 4), eye, { pos: [0.4, 1.1, -0.18], glow: 2.6, scl: [0.7, 1.3, 1] }),
    part(cone(0.1, 0.34, 4), dark, { pos: [-0.05, 1.62, 0.22], rot: [0.3, 0, 0.2] }),
    part(cone(0.1, 0.34, 4), dark, { pos: [-0.05, 1.62, -0.22], rot: [-0.3, 0, 0.2] }),
  ]);
}

export function geoSkitter(): THREE.BufferGeometry {
  const body = 0x12262a, leg = 0x0a1518, eye = 0x9dff5a;
  const parts = [
    part(sph(0.34, 7, 5), body, { pos: [-0.08, 0.38, 0], scl: [1.25, 0.72, 1], jitter: 0.15 }),
    part(sph(0.2, 6, 4), body, { pos: [0.32, 0.36, 0], jitter: 0.1 }),
    part(sph(0.06, 5, 3), eye, { pos: [0.48, 0.42, 0.09], glow: 3 }),
    part(sph(0.06, 5, 3), eye, { pos: [0.48, 0.42, -0.09], glow: 3 }),
    part(cone(0.08, 0.3, 4), leg, { pos: [-0.5, 0.42, 0], rot: [0, 0, HP + 0.4] }),
  ];
  for (let i = 0; i < 3; i++) {
    const x = 0.22 - i * 0.24;
    for (const s of [1, -1]) {
      parts.push(part(box(0.06, 0.07, 0.5), leg, { pos: [x, 0.3, s * 0.44], rot: [s * 0.55, i * 0.25 - 0.25, 0], sway: -1 }));
      parts.push(part(box(0.05, 0.34, 0.05), leg, { pos: [x, 0.13, s * 0.66], sway: -1 }));
    }
  }
  return merge(parts);
}

export function geoBrute(): THREE.BufferGeometry {
  const body = 0x2e1218, dark = 0x1a0a0e, eye = 0xff8a2a, horn = 0x6b5a4a;
  const arm = (x: number, y: number) => (y < 1.2 ? 0.6 : 0);
  return merge([
    part(box(1.1, 1.0, 1.35), body, { pos: [0, 1.25, 0], jitter: 0.14 }),
    part(box(0.9, 0.6, 1.05), dark, { pos: [-0.05, 0.6, 0], jitter: 0.1 }),
    part(box(0.5, 0.48, 0.55), body, { pos: [0.38, 1.9, 0], jitter: 0.1 }),
    part(sph(0.09, 5, 3), eye, { pos: [0.64, 1.95, 0.15], glow: 3 }),
    part(sph(0.09, 5, 3), eye, { pos: [0.64, 1.95, -0.15], glow: 3 }),
    part(cone(0.11, 0.5, 5), horn, { pos: [0.3, 2.28, 0.26], rot: [0.5, 0, -0.3] }),
    part(cone(0.11, 0.5, 5), horn, { pos: [0.3, 2.28, -0.26], rot: [-0.5, 0, -0.3] }),
    part(box(0.42, 1.25, 0.42), dark, { pos: [0.1, 0.95, 0.9], sway: arm, jitter: 0.1 }),
    part(box(0.42, 1.25, 0.42), dark, { pos: [0.1, 0.95, -0.9], sway: arm, jitter: 0.1 }),
    part(box(0.56, 0.5, 0.56), body, { pos: [0.16, 0.34, 0.9], sway: 0.6 }),
    part(box(0.56, 0.5, 0.56), body, { pos: [0.16, 0.34, -0.9], sway: 0.6 }),
    part(box(0.4, 0.4, 0.36), dark, { pos: [0, 0.2, 0.3], sway: -0.6 }),
    part(box(0.4, 0.4, 0.36), dark, { pos: [0, 0.2, -0.3], sway: -0.6 }),
    part(box(0.25, 0.1, 0.9), eye, { pos: [0.56, 1.3, 0], glow: 1.4 }),
  ]);
}

export function geoSpitter(): THREE.BufferGeometry {
  const body = 0x15301f, dark = 0x0c1c12, glow = 0xa6ff3a;
  const st = (x: number, y: number) => Math.max(0, y - 0.3) * 0.35;
  return merge([
    part(cyl(0.2, 0.34, 1.2, 6), body, { pos: [0, 0.6, 0], sway: st, jitter: 0.12 }),
    part(sph(0.44, 7, 6), body, { pos: [0.05, 1.45, 0], scl: [1.15, 0.95, 1], sway: 0.4, jitter: 0.12 }),
    part(sph(0.2, 6, 4), glow, { pos: [0.4, 1.42, 0], glow: 2.4, sway: 0.4, scl: [0.7, 1, 1.15] }),
    part(cone(0.13, 0.45, 4), dark, { pos: [-0.2, 1.9, 0.2], rot: [0.4, 0, 0.5], sway: 0.5 }),
    part(cone(0.13, 0.45, 4), dark, { pos: [-0.2, 1.9, -0.2], rot: [-0.4, 0, 0.5], sway: 0.5 }),
    part(cone(0.13, 0.5, 4), dark, { pos: [-0.32, 1.75, 0], rot: [0, 0, 0.9], sway: 0.5 }),
    part(sph(0.07, 5, 3), glow, { pos: [0.02, 0.7, 0.26], glow: 1.8 }),
    part(sph(0.07, 5, 3), glow, { pos: [-0.1, 1.0, -0.24], glow: 1.8 }),
    part(cone(0.42, 0.25, 6), dark, { pos: [0, 0.12, 0] }),
  ]);
}

export function geoWraith(): THREE.BufferGeometry {
  const body = 0x1b2440, pale = 0x3a4a78, eye = 0x6cf2ff;
  const tail = (x: number, y: number) => Math.max(0, 1.0 - y) * 0.9 + Math.max(0, -x) * 0.5;
  return merge([
    part(cone(0.42, 1.7, 6), body, { pos: [-0.25, 0.95, 0], rot: [0, 0, -HP + 0.75], sway: tail, jitter: 0.12 }),
    part(oct(0.36), pale, { pos: [0.3, 1.5, 0], scl: [1.2, 1, 0.8], jitter: 0.1 }),
    part(box(0.08, 0.08, 0.5), eye, { pos: [0.58, 1.52, 0], glow: 3 }),
    part(cone(0.1, 1.1, 4), pale, { pos: [0.35, 1.05, 0.55], rot: [0.5, 0, -1.2], sway: 0.6 }),
    part(cone(0.1, 1.1, 4), pale, { pos: [0.35, 1.05, -0.55], rot: [-0.5, 0, -1.2], sway: 0.6 }),
    part(cone(0.07, 0.5, 4), eye, { pos: [0.85, 0.8, 0.72], rot: [0.5, 0, -1.2], glow: 1.6, sway: 0.6 }),
    part(cone(0.07, 0.5, 4), eye, { pos: [0.85, 0.8, -0.72], rot: [-0.5, 0, -1.2], glow: 1.6, sway: 0.6 }),
  ]);
}

export function geoBomber(): THREE.BufferGeometry {
  const body = 0x2a1220, core = 0xff3a6a, leg = 0x140a10;
  const parts = [
    part(lumpy(ico(0.48, 1), 0.1, 3), body, { pos: [0, 0.68, 0], jitter: 0.15 }),
    part(ico(0.3, 0), core, { pos: [0, 0.68, 0], glow: 2.2, scl: 1.25 }),
    part(sph(0.07, 5, 3), 0xffe0a0, { pos: [0.42, 0.8, 0.14], glow: 3 }),
    part(sph(0.07, 5, 3), 0xffe0a0, { pos: [0.42, 0.8, -0.14], glow: 3 }),
    part(box(0.12, 0.3, 0.12), leg, { pos: [0.05, 0.14, 0.22], sway: -0.8 }),
    part(box(0.12, 0.3, 0.12), leg, { pos: [0.05, 0.14, -0.22], sway: -0.8 }),
    part(cyl(0.05, 0.05, 0.3, 4), leg, { pos: [0, 1.25, 0] }),
    part(sph(0.08, 5, 3), 0xffc24a, { pos: [0, 1.42, 0], glow: 3.5 }),
  ];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    parts.push(part(cone(0.1, 0.34, 4), leg, { pos: [Math.cos(a) * 0.5, 0.68 + (i % 2 ? 0.2 : -0.12), Math.sin(a) * 0.5], rot: [Math.sin(a) * HP, 0, -Math.cos(a) * HP] }));
  }
  return merge(parts);
}

export function geoHusk(): THREE.BufferGeometry {
  const shell = 0x3a3220, dark = 0x1c170e, glow = 0xffd24a;
  return merge([
    part(lumpy(ico(0.62, 1), 0.12, 5), shell, { pos: [0, 0.75, 0], scl: [1, 1.15, 1], jitter: 0.16 }),
    part(lumpy(ico(0.42, 1), 0.12, 6), shell, { pos: [0.2, 1.5, 0], jitter: 0.16 }),
    part(box(0.06, 0.8, 0.5), glow, { pos: [0.55, 0.8, 0], glow: 2, rot: [0.2, 0, 0.1] }),
    part(box(0.05, 0.4, 0.3), glow, { pos: [0.3, 0.9, 0.52], glow: 2, rot: [0, 0.9, 0.3] }),
    part(sph(0.08, 5, 3), glow, { pos: [0.55, 1.55, 0.14], glow: 3 }),
    part(sph(0.08, 5, 3), glow, { pos: [0.55, 1.55, -0.14], glow: 3 }),
    part(box(0.3, 0.3, 0.3), dark, { pos: [0, 0.15, 0.3], sway: -0.7 }),
    part(box(0.3, 0.3, 0.3), dark, { pos: [0, 0.15, -0.3], sway: -0.7 }),
    part(box(0.2, 0.7, 0.2), dark, { pos: [0.15, 0.9, 0.7], rot: [0.3, 0, 0], sway: 0.5 }),
    part(box(0.2, 0.7, 0.2), dark, { pos: [0.15, 0.9, -0.7], rot: [-0.3, 0, 0], sway: 0.5 }),
  ]);
}

export function geoHerald(): THREE.BufferGeometry {
  const armor = 0x2a2238, dark = 0x120e1c, glow = 0xb04aff, bone = 0x8a7f9a;
  const cape = (x: number, y: number) => (x < -0.2 ? Math.max(0, 2.6 - y) * 0.5 : 0);
  const parts = [
    part(cone(1.15, 2.4, 8), dark, { pos: [0, 1.2, 0], jitter: 0.12 }),
    part(box(1.3, 1.2, 1.9), armor, { pos: [0.05, 2.7, 0], jitter: 0.14 }),
    part(box(0.25, 2.6, 1.9), 0x3b1450, { pos: [-0.75, 1.9, 0], sway: cape, rot: [0, 0, -0.12] }),
    part(box(0.7, 0.75, 0.7), armor, { pos: [0.25, 3.7, 0], jitter: 0.1 }),
    part(box(0.12, 0.2, 0.5), glow, { pos: [0.62, 3.72, 0], glow: 3.4 }),
    part(sph(0.26, 6, 5), glow, { pos: [0.7, 2.8, 0], glow: 2.6 }),
    part(sph(0.55, 6, 5), armor, { pos: [0, 3.25, 1.15], jitter: 0.12 }),
    part(sph(0.55, 6, 5), armor, { pos: [0, 3.25, -1.15], jitter: 0.12 }),
    part(box(0.45, 1.7, 0.45), dark, { pos: [0.2, 2.2, 1.25], sway: 0.5 }),
    part(box(0.45, 1.7, 0.45), dark, { pos: [0.2, 2.2, -1.25], sway: 0.5 }),
    part(box(0.16, 3.6, 0.16), bone, { pos: [0.75, 2.2, 1.3], rot: [0, 0, -0.1] }),
    part(oct(0.42), glow, { pos: [0.93, 4.2, 1.3], glow: 3, scl: [0.7, 1.5, 0.7] }),
  ];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5 - 0.5) * 2.4;
    parts.push(part(cone(0.1, 0.6, 4), bone, { pos: [0.25 + Math.cos(a) * 0.3, 4.3, Math.sin(a) * 0.36], rot: [Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.2] }));
  }
  return merge(parts);
}

/** Final boss body: a black sun wearing a crown of thorns. Core glow + ring are separate meshes. */
export function geoEclipse(): THREE.BufferGeometry {
  const dark = 0x07040e, rim = 0x241038, glow = 0xff5a3c, eye = 0xfff0c0;
  const parts = [
    part(lumpy(ico(2.3, 2), 0.05, 9), dark, { pos: [0, 4.2, 0], jitter: 0.25 }),
    // a single burning eye, tilted up so the high camera can meet its gaze
    part(sph(0.8, 10, 8), eye, { pos: [1.55, 5.5, 0], glow: 2.6, scl: [0.55, 0.8, 1.15], rot: [0, 0, 0.75] }),
    part(sph(0.4, 8, 6), 0x1a0408, { pos: [1.8, 5.75, 0], scl: [0.5, 0.7, 0.45], rot: [0, 0, 0.75] }),
    part(cone(1.6, 3.4, 9), rim, { pos: [0, 1.6, 0], rot: [Math.PI, 0, 0], sway: (x, y) => Math.max(0, 2.6 - y) * 0.4, jitter: 0.16 }),
  ];
  // crown of thorns around the equator: reads as a black sun from above
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const long = i % 2 === 0;
    const len = long ? 2.6 : 1.5;
    const r = 2.2 + len * 0.45;
    parts.push(part(cone(0.34, len, 4), long ? glow : rim, {
      pos: [Math.cos(a) * r, 4.2 + (long ? 0.15 : -0.2), Math.sin(a) * r],
      rot: [0, -a, -Math.PI / 2], glow: long ? 1.5 : 0,
    }));
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    parts.push(part(cone(0.22, 1.4, 4), rim, { pos: [Math.cos(a) * 1.1, 6.6, Math.sin(a) * 1.1], rot: [Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5] }));
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    parts.push(part(box(0.12, 1.1, 0.26), glow, { pos: [Math.cos(a) * 2.2, 4.2 + Math.sin(a * 2) * 1.0, Math.sin(a) * 2.2], rot: [0, -a, 0.4], glow: 1.8 }));
  }
  return merge(parts);
}

// =====================================================================================
// PLAYER PARTS (each animated separately)
// =====================================================================================
export interface PlayerGeo {
  body: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
  lantern: THREE.BufferGeometry;
}

export function geoPlayer(cloak: number, accent: number): PlayerGeo {
  const c = new THREE.Color(cloak);
  const darker = c.clone().multiplyScalar(0.62).getHex();
  const lighter = c.clone().lerp(new THREE.Color(0xffffff), 0.18).getHex();
  const skin = 0x15121c;
  const cape = (x: number, y: number) => (x < 0 ? Math.max(0, 1.05 - y) * 0.9 : Math.max(0, 0.6 - y) * 0.3);
  const body = merge([
    // robe: flared cone, slightly longer at the back
    part(cyl(0.2, 0.52, 0.95, 8), cloak, { pos: [0, 0.72, 0], sway: cape, jitter: 0.08, grad: [0.8, 1.05] }),
    part(cyl(0.3, 0.24, 0.3, 8), lighter, { pos: [0, 1.22, 0] }),
    part(box(0.5, 0.09, 0.56), darker, { pos: [0, 1.0, 0] }),
    part(box(0.1, 0.12, 0.14), accent, { pos: [0.26, 1.0, 0], glow: 1.4 }),
    // short cape
    part(box(0.08, 0.85, 0.66), darker, { pos: [-0.3, 0.9, 0], rot: [0, 0, -0.22], sway: (x, y) => Math.max(0, 1.3 - y) * 1.1 }),
  ]);
  const head = merge([
    part(sph(0.24, 8, 6), skin, { pos: [0.02, 0.18, 0] }),
    // hood
    part(sph(0.31, 8, 6), cloak, { pos: [-0.05, 0.22, 0], scl: [1.05, 1.05, 1], jitter: 0.08 }),
    part(cone(0.2, 0.42, 6), cloak, { pos: [-0.3, 0.42, 0], rot: [0, 0, 1.1] }),
    part(sph(0.26, 8, 6), skin, { pos: [0.08, 0.17, 0], scl: [0.9, 0.82, 0.86] }),
    part(sph(0.055, 5, 3), accent, { pos: [0.3, 0.2, 0.1], glow: 3.2 }),
    part(sph(0.055, 5, 3), accent, { pos: [0.3, 0.2, -0.1], glow: 3.2 }),
  ]);
  const arm = merge([
    part(cyl(0.09, 0.07, 0.5, 6), lighter, { pos: [0, -0.22, 0] }),
    part(sph(0.08, 5, 4), skin, { pos: [0, -0.5, 0] }),
  ]);
  const leg = merge([
    part(box(0.15, 0.42, 0.15), 0x1a1620, { pos: [0, -0.2, 0] }),
    part(box(0.24, 0.1, 0.16), 0x2c2430, { pos: [0.05, -0.42, 0] }),
  ]);
  const lantern = merge([
    part(cyl(0.02, 0.02, 0.2, 4), 0x40382e, { pos: [0, 0.2, 0] }),
    part(cone(0.13, 0.1, 6), 0x40382e, { pos: [0, 0.12, 0] }),
    part(cyl(0.1, 0.1, 0.2, 6), accent, { pos: [0, 0, 0], glow: 4 }),
    part(cyl(0.12, 0.09, 0.05, 6), 0x40382e, { pos: [0, -0.12, 0] }),
  ]);
  return { body, head, arm, leg, lantern };
}

// =====================================================================================
// WORLD PROPS
// =====================================================================================
const swayY = (k: number, y0 = 0.6) => (x: number, y: number) => Math.max(0, y - y0) * k;

export function geoPine(leafA: number, leafB: number, trunk: number, snow = 0): THREE.BufferGeometry {
  const parts = [part(cyl(0.16, 0.26, 1.6, 6), trunk, { pos: [0, 0.8, 0], jitter: 0.1 })];
  const tiers = 4;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const r = 1.55 - t * 0.95, h = 1.5 - t * 0.3;
    const y = 1.6 + i * 0.95;
    parts.push(part(cone(r, h, 7), i % 2 ? leafA : leafB, { pos: [0, y + h / 2 - 0.3, 0], rot: [0, i * 0.7, 0], sway: swayY(0.5, 1), jitter: 0.12, grad: [0.7, 1.1] }));
    if (snow) parts.push(part(cone(r * 0.62, h * 0.55, 7), snow, { pos: [0, y + h * 0.72 - 0.3, 0], rot: [0, i * 0.7, 0], sway: swayY(0.5, 1), jitter: 0.05 }));
  }
  return merge(parts);
}

export function geoOak(leafA: number, leafB: number, trunk: number): THREE.BufferGeometry {
  return merge([
    part(cyl(0.2, 0.34, 2.0, 6), trunk, { pos: [0, 1.0, 0], jitter: 0.1 }),
    part(cyl(0.09, 0.14, 1.0, 5), trunk, { pos: [0.4, 2.0, 0.1], rot: [0, 0, -0.8] }),
    part(cyl(0.09, 0.14, 1.0, 5), trunk, { pos: [-0.35, 2.1, -0.2], rot: [0.3, 0, 0.8] }),
    part(lumpy(ico(1.35, 1), 0.16, 11), leafA, { pos: [0, 3.3, 0], scl: [1.1, 0.85, 1.1], sway: swayY(0.42, 1.6), jitter: 0.14, grad: [0.65, 1.1] }),
    part(lumpy(ico(0.95, 1), 0.18, 12), leafB, { pos: [0.95, 2.75, 0.3], sway: swayY(0.42, 1.6), jitter: 0.14, grad: [0.7, 1.1] }),
    part(lumpy(ico(0.9, 1), 0.18, 13), leafB, { pos: [-0.8, 2.9, -0.5], sway: swayY(0.42, 1.6), jitter: 0.14, grad: [0.7, 1.1] }),
    part(lumpy(ico(0.7, 1), 0.18, 14), leafA, { pos: [0.1, 2.8, 0.95], sway: swayY(0.42, 1.6), jitter: 0.14, grad: [0.7, 1.1] }),
  ]);
}

export function geoDeadTree(trunk: number): THREE.BufferGeometry {
  return merge([
    part(cyl(0.12, 0.3, 2.6, 6), trunk, { pos: [0, 1.3, 0], rot: [0, 0, 0.06], jitter: 0.12 }),
    part(cyl(0.05, 0.11, 1.5, 5), trunk, { pos: [0.5, 2.5, 0], rot: [0, 0, -0.9], sway: 0.2 }),
    part(cyl(0.04, 0.09, 1.2, 5), trunk, { pos: [-0.42, 2.9, 0.12], rot: [0.2, 0, 0.8], sway: 0.25 }),
    part(cyl(0.03, 0.07, 0.9, 5), trunk, { pos: [0.1, 3.2, -0.32], rot: [-0.7, 0, 0.1], sway: 0.3 }),
    part(cyl(0.03, 0.06, 0.8, 4), trunk, { pos: [0.95, 3.1, 0.05], rot: [0, 0, -0.3], sway: 0.3 }),
  ]);
}

export function geoRock(color: number, variant: number, moss = 0): THREE.BufferGeometry {
  const parts = [part(lumpy(ico(1, 1), 0.22, 20 + variant), color, { pos: [0, 0.45, 0], scl: [1, 0.72 + variant * 0.08, 0.88], jitter: 0.16, grad: [0.72, 1.08] })];
  if (variant % 2) parts.push(part(lumpy(ico(0.55, 0), 0.2, 30 + variant), color, { pos: [0.8, 0.22, 0.35], jitter: 0.16 }));
  if (moss) parts.push(part(lumpy(ico(0.62, 1), 0.2, 40 + variant), moss, { pos: [-0.1, 0.92 + variant * 0.06, 0.05], scl: [1.1, 0.35, 1], jitter: 0.12 }));
  return merge(parts);
}

export function geoPillar(stone: number, variant: number): THREE.BufferGeometry {
  const h = 2.2 + variant * 0.75;
  const parts = [
    part(box(1.35, 0.35, 1.35), stone, { pos: [0, 0.175, 0], jitter: 0.1 }),
    part(cyl(0.48, 0.55, h, 8), stone, { pos: [0, 0.35 + h / 2, 0], jitter: 0.12, grad: [0.75, 1.05] }),
  ];
  if (variant >= 2) parts.push(part(box(1.25, 0.32, 1.25), stone, { pos: [0, 0.35 + h + 0.16, 0], rot: [0, 0.2, 0.04], jitter: 0.1 }));
  else parts.push(part(lumpy(ico(0.5, 0), 0.3, 50 + variant), stone, { pos: [0.1, 0.35 + h, 0], scl: [1, 0.5, 1], jitter: 0.14 }));
  return merge(parts);
}

export function geoWall(stone: number, variant: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const r = new RNG(700 + variant);
  // stepped broken wall, long axis along X
  const cols = 4;
  for (let i = 0; i < cols; i++) {
    const hh = 0.9 + r.range(0, 1.7) * (i === 1 || i === 2 ? 1 : 0.6);
    parts.push(part(box(0.66, hh, 0.7), stone, { pos: [(i - (cols - 1) / 2) * 0.64, hh / 2, r.range(-0.04, 0.04)], rot: [0, r.range(-0.05, 0.05), 0], jitter: 0.12, grad: [0.75, 1.05] }));
  }
  parts.push(part(box(0.5, 0.36, 0.5), stone, { pos: [0.9, 0.18, 0.75], rot: [0, 0.6, 0.15], jitter: 0.1 }));
  return merge(parts);
}

export function geoCrystal(color: number, variant: number): THREE.BufferGeometry {
  const r = new RNG(900 + variant);
  const parts = [part(lumpy(ico(0.55, 0), 0.2, 60), 0x2a2a38, { pos: [0, 0.12, 0], scl: [1.2, 0.4, 1.2] })];
  const n = 3 + variant;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r.range(-0.3, 0.3);
    const lean = i === 0 ? 0 : r.range(0.25, 0.6);
    const h = i === 0 ? 2.0 : r.range(0.8, 1.5);
    const d = i === 0 ? 0 : 0.34;
    parts.push(part(cyl(0, 0.22, h, 5), color, { pos: [Math.cos(a) * (d + lean * h * 0.3), h / 2 + 0.1, Math.sin(a) * (d + lean * h * 0.3)], rot: [Math.sin(a) * lean, 0, -Math.cos(a) * lean], glow: 1.5, grad: [0.5, 1.2] }));
  }
  return merge(parts);
}

export function geoStump(trunk: number): THREE.BufferGeometry {
  return merge([
    part(cyl(0.42, 0.55, 0.55, 7), trunk, { pos: [0, 0.275, 0], jitter: 0.12 }),
    part(cyl(0.36, 0.36, 0.04, 7), 0x8a6f4d, { pos: [0, 0.56, 0] }),
    part(cyl(0.08, 0.16, 0.5, 4), trunk, { pos: [0.5, 0.1, 0.1], rot: [0, 0, 1.2] }),
  ]);
}

export function geoBigShroom(stem: number, cap: number, glow: number): THREE.BufferGeometry {
  return merge([
    part(cyl(0.14, 0.22, 1.3, 6), stem, { pos: [0, 0.65, 0], rot: [0, 0, 0.08], sway: swayY(0.2, 0.3) }),
    part(sph(0.72, 8, 5), cap, { pos: [-0.05, 1.3, 0], scl: [1, 0.55, 1], sway: 0.25, jitter: 0.1 }),
    part(cyl(0.6, 0.66, 0.06, 8), glow, { pos: [-0.05, 1.22, 0], glow: 1.6, sway: 0.25 }),
    part(cyl(0.07, 0.1, 0.6, 5), stem, { pos: [0.5, 0.3, 0.3], sway: swayY(0.2, 0.2) }),
    part(sph(0.3, 6, 4), cap, { pos: [0.5, 0.6, 0.3], scl: [1, 0.6, 1], sway: 0.15 }),
    part(cyl(0.24, 0.27, 0.04, 6), glow, { pos: [0.5, 0.56, 0.3], glow: 1.6, sway: 0.15 }),
  ]);
}

export function geoIce(color: number, variant: number): THREE.BufferGeometry {
  const r = new RNG(1100 + variant);
  const parts: THREE.BufferGeometry[] = [];
  const n = 3 + variant;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const h = i === 0 ? 2.4 : r.range(0.9, 1.8);
    const d = i === 0 ? 0 : 0.45;
    const lean = i === 0 ? 0.05 : r.range(0.2, 0.5);
    parts.push(part(cyl(0, 0.36, h, 4), color, { pos: [Math.cos(a) * d, h / 2, Math.sin(a) * d], rot: [Math.sin(a) * lean, r.angle(), -Math.cos(a) * lean], glow: 0.25, jitter: 0.1, grad: [0.7, 1.25] }));
  }
  return merge(parts);
}

export function geoCactus(color: number, flower: number): THREE.BufferGeometry {
  return merge([
    part(cyl(0.3, 0.34, 2.2, 7), color, { pos: [0, 1.1, 0], jitter: 0.1, grad: [0.75, 1.1] }),
    part(sph(0.3, 7, 4), color, { pos: [0, 2.2, 0] }),
    part(cyl(0.18, 0.18, 0.7, 6), color, { pos: [0.55, 1.2, 0], rot: [0, 0, HP] }),
    part(cyl(0.18, 0.2, 0.9, 6), color, { pos: [0.85, 1.6, 0] }),
    part(cyl(0.16, 0.16, 0.6, 6), color, { pos: [-0.5, 0.9, 0], rot: [0, 0, HP] }),
    part(cyl(0.16, 0.18, 0.7, 6), color, { pos: [-0.75, 1.2, 0] }),
    part(sph(0.12, 5, 3), flower, { pos: [0, 2.52, 0], glow: 1.2 }),
  ]);
}

export function geoBone(color: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [part(cyl(0.12, 0.14, 3.0, 5), color, { pos: [0, 0.2, 0], rot: [0, 0, HP], jitter: 0.08 })];
  for (let i = 0; i < 5; i++) {
    const x = -1.1 + i * 0.55;
    const h = 1.1 + Math.sin((i / 4) * Math.PI) * 0.8;
    parts.push(part(torus(h * 0.5, 0.07, 4, 8).rotateY(HP), color, { pos: [x, 0.2, 0], scl: [1, 1.5, 1], jitter: 0.08 }));
  }
  return merge(parts);
}

// ---- small decor (no collision)
export function geoGrassTuft(color: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const r = new RNG(77);
  for (let i = 0; i < 5; i++) {
    const a = r.angle();
    const h = r.range(0.35, 0.75);
    const blade = new THREE.BufferGeometry();
    const w = 0.07;
    const d = r.range(0.02, 0.16);
    const lx = Math.cos(a) * 0.14 * h, lz = Math.sin(a) * 0.14 * h;
    const cx = Math.cos(a) * d, cz = Math.sin(a) * d;
    const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
    blade.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      cx - px, 0, cz - pz, cx + px, 0, cz + pz, cx + lx * 2.2, h, cz + lz * 2.2,
      cx + px, 0, cz + pz, cx - px, 0, cz - pz, cx + lx * 2.2, h, cz + lz * 2.2,
    ]), 3));
    blade.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    parts.push(part(blade, color, { sway: (x, y) => y * 2.2, grad: [0.55, 1.25] }));
  }
  return merge(parts);
}

export function geoFlower(stem: number): THREE.BufferGeometry {
  // petals are white so the instance colour decides the flower colour
  return merge([
    part(cyl(0.015, 0.02, 0.5, 3), stem, { pos: [0, 0.25, 0], sway: swayY(1.6, 0) }),
    part(oct(0.09), 0xffffff, { pos: [0, 0.54, 0], glow: 2.2, sway: 0.9, scl: [1.2, 0.7, 1.2] }),
  ]);
}

export function geoSmallShroom(): THREE.BufferGeometry {
  return merge([
    part(cyl(0.03, 0.045, 0.22, 4), 0xcfc6b0, { pos: [0, 0.11, 0] }),
    part(sph(0.12, 6, 3), 0xffffff, { pos: [0, 0.22, 0], scl: [1, 0.6, 1], glow: 1.5 }),
    part(cyl(0.02, 0.03, 0.14, 4), 0xcfc6b0, { pos: [0.14, 0.07, 0.06] }),
    part(sph(0.07, 5, 3), 0xffffff, { pos: [0.14, 0.14, 0.06], scl: [1, 0.6, 1], glow: 1.5 }),
  ]);
}

export function geoPebble(color: number): THREE.BufferGeometry {
  return merge([part(lumpy(ico(0.2, 0), 0.25, 81), color, { pos: [0, 0.07, 0], scl: [1, 0.55, 0.8], jitter: 0.15 })]);
}

export function geoFern(color: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    parts.push(part(cone(0.1, 0.7, 3), color, { pos: [Math.cos(a) * 0.24, 0.2, Math.sin(a) * 0.24], rot: [Math.sin(a) * 1.05, 0, -Math.cos(a) * 1.05], sway: (x, y) => y * 1.2, scl: [1, 1, 0.35], grad: [0.6, 1.2] }));
  }
  return merge(parts);
}

// ---- structures
export function geoBeacon(stone: number, dark: number): THREE.BufferGeometry {
  const parts = [
    part(cyl(3.3, 3.6, 0.35, 10), stone, { pos: [0, 0.175, 0], jitter: 0.1 }),
    part(cyl(2.5, 2.8, 0.35, 10), stone, { pos: [0, 0.525, 0], jitter: 0.1 }),
    part(cyl(1.5, 1.8, 0.4, 8), dark, { pos: [0, 0.9, 0], jitter: 0.1 }),
    part(cyl(0.55, 0.85, 2.6, 8), stone, { pos: [0, 2.4, 0], jitter: 0.12, grad: [0.8, 1.05] }),
    part(cyl(1.3, 0.6, 0.6, 8), dark, { pos: [0, 4.0, 0], jitter: 0.1 }),
    part(torus(1.3, 0.12, 5, 10).rotateX(HP), stone, { pos: [0, 4.32, 0] }),
  ];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    parts.push(part(box(0.5, 3.2, 0.5), stone, { pos: [Math.cos(a) * 2.35, 2.3, Math.sin(a) * 2.35], rot: [0, -a, 0], jitter: 0.12, grad: [0.8, 1.05] }));
    parts.push(part(cone(0.42, 0.7, 4), dark, { pos: [Math.cos(a) * 2.35, 4.25, Math.sin(a) * 2.35], rot: [0, -a + Math.PI / 4, 0] }));
  }
  return merge(parts);
}

export function geoHearth(stone: number, wood: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [part(cyl(1.5, 1.7, 0.2, 10), 0x2a2622, { pos: [0, 0.1, 0] })];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    parts.push(part(lumpy(ico(0.36, 0), 0.22, 200 + i), stone, { pos: [Math.cos(a) * 1.5, 0.22, Math.sin(a) * 1.5], scl: [1, 0.75, 1], jitter: 0.15 }));
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    parts.push(part(cyl(0.12, 0.14, 1.6, 5), wood, { pos: [Math.cos(a) * 0.36, 0.6, Math.sin(a) * 0.36], rot: [Math.sin(a) * 0.62, 0, -Math.cos(a) * 0.62], jitter: 0.1 }));
  }
  return merge(parts);
}

export function geoChest(): THREE.BufferGeometry {
  const wood = 0x6a3d22, gold = 0xffc44a;
  return merge([
    part(box(1.0, 0.55, 0.7), wood, { pos: [0, 0.275, 0], jitter: 0.08 }),
    part(cyl(0.35, 0.35, 1.0, 8, ).rotateZ(HP), wood, { pos: [0, 0.55, 0], scl: [1, 0.7, 1], jitter: 0.08 }),
    part(box(0.12, 0.84, 0.74), gold, { pos: [0.32, 0.4, 0], glow: 0.5 }),
    part(box(0.12, 0.84, 0.74), gold, { pos: [-0.32, 0.4, 0], glow: 0.5 }),
    part(box(0.2, 0.22, 0.1), gold, { pos: [0, 0.5, 0.37], glow: 1.6 }),
  ]);
}

export function geoGem(): THREE.BufferGeometry {
  return merge([part(oct(0.26), 0xffffff, { scl: [0.8, 1.25, 0.8], glow: 1.1 })]);
}

export function geoHeart(): THREE.BufferGeometry {
  return merge([
    part(sph(0.2, 6, 5), 0xffffff, { pos: [0, 0.08, 0.13], glow: 1.6 }),
    part(sph(0.2, 6, 5), 0xffffff, { pos: [0, 0.08, -0.13], glow: 1.6 }),
    part(cone(0.29, 0.42, 4), 0xffffff, { pos: [0, -0.16, 0], rot: [Math.PI, Math.PI / 4, 0], scl: [0.6, 1, 1.05], glow: 1.6 }),
  ]);
}

export function geoMagnet(): THREE.BufferGeometry {
  return merge([
    part(new THREE.TorusGeometry(0.24, 0.085, 5, 10, Math.PI).rotateY(HP), 0xffffff, { pos: [0, 0.05, 0], glow: 1.2 }),
    part(box(0.17, 0.14, 0.17), 0xfff2d0, { pos: [0, -0.02, 0.24], glow: 2.4 }),
    part(box(0.17, 0.14, 0.17), 0xfff2d0, { pos: [0, -0.02, -0.24], glow: 2.4 }),
  ]);
}

export function geoCoin(): THREE.BufferGeometry {
  return merge([
    part(cyl(0.24, 0.24, 0.07, 8).rotateX(HP), 0xffffff, { glow: 1.3 }),
    part(oct(0.12), 0xfff6d0, { glow: 2.6, scl: [1, 1, 0.5] }),
  ]);
}
