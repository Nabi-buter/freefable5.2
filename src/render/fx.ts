import * as THREE from 'three';
import { HEIGHT_GLSL, shared } from './materials';

// =====================================================================================
// Particles — CPU simulated, GPU point sprites
// =====================================================================================
const STRIDE = 14; // px py pz vx vy vz life maxLife size0 size1 grav drag (r g b stored separately)

export interface PSpawn {
  grav?: number;
  drag?: number;
  size1?: number;
}

export class Particles {
  readonly points: THREE.Points;
  private max: number;
  private data: Float32Array;
  private rgb: Float32Array;
  private cursor = 0;
  private pos: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private size: THREE.BufferAttribute;
  private mat: THREE.ShaderMaterial;
  /** spawn-rate multiplier from the quality setting */
  density = 1;
  private acc = 0;

  constructor(max: number, additive: boolean) {
    this.max = max;
    this.data = new Float32Array(max * STRIDE);
    this.rgb = new Float32Array(max * 3);
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(max * 4), 4);
    this.size = new THREE.BufferAttribute(new Float32Array(max), 1);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.col.setUsage(THREE.DynamicDrawUsage);
    this.size.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aColor', this.col);
    geo.setAttribute('aSize', this.size);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute vec4 aColor;
        attribute float aSize;
        varying vec4 vColor;
        uniform float uScale;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: additive
        ? /* glsl */ `
        varying vec4 vColor;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          float a = smoothstep(1.0, 0.0, d);
          a = a * a;
          gl_FragColor = vec4(vColor.rgb * a * vColor.a, 1.0);
        }`
        : /* glsl */ `
        varying vec4 vColor;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          float a = smoothstep(1.0, 0.35, d) * vColor.a;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor.rgb, a);
        }`,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
  }

  setScale(pxHeight: number, fovDeg: number) {
    this.mat.uniforms.uScale.value = pxHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, r: number, g: number, b: number, o?: PSpawn) {
    // probabilistic thinning for lower quality settings
    if (this.density < 1) {
      this.acc += this.density;
      if (this.acc < 1) return;
      this.acc -= 1;
    }
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const d = this.data, k = i * STRIDE;
    d[k] = x; d[k + 1] = y; d[k + 2] = z;
    d[k + 3] = vx; d[k + 4] = vy; d[k + 5] = vz;
    d[k + 6] = life; d[k + 7] = life;
    d[k + 8] = size; d[k + 9] = o?.size1 ?? 0;
    d[k + 10] = o?.grav ?? 0; d[k + 11] = o?.drag ?? 0;
    this.rgb[i * 3] = r; this.rgb[i * 3 + 1] = g; this.rgb[i * 3 + 2] = b;
  }

  update(dt: number) {
    const d = this.data;
    const pa = this.pos.array as Float32Array;
    const ca = this.col.array as Float32Array;
    const sa = this.size.array as Float32Array;
    for (let i = 0; i < this.max; i++) {
      const k = i * STRIDE;
      let life = d[k + 6];
      if (life <= 0) {
        sa[i] = 0;
        continue;
      }
      life -= dt;
      d[k + 6] = life;
      if (life <= 0) {
        sa[i] = 0;
        continue;
      }
      const drag = d[k + 11];
      if (drag > 0) {
        const f = Math.exp(-drag * dt);
        d[k + 3] *= f; d[k + 4] *= f; d[k + 5] *= f;
      }
      d[k + 4] -= d[k + 10] * dt;
      d[k] += d[k + 3] * dt; d[k + 1] += d[k + 4] * dt; d[k + 2] += d[k + 5] * dt;
      const t = life / d[k + 7];
      pa[i * 3] = d[k]; pa[i * 3 + 1] = d[k + 1]; pa[i * 3 + 2] = d[k + 2];
      sa[i] = d[k + 9] + (d[k + 8] - d[k + 9]) * t;
      // fade in quickly, fade out smoothly
      const a = Math.min(1, (1 - t) * 12) * Math.min(1, t * 2.2);
      ca[i * 4] = this.rgb[i * 3]; ca[i * 4 + 1] = this.rgb[i * 3 + 1]; ca[i * 4 + 2] = this.rgb[i * 3 + 2]; ca[i * 4 + 3] = a;
    }
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.size.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < this.max; i++) this.data[i * STRIDE + 6] = 0;
  }

  dispose() {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}

// =====================================================================================
// Ground decals — instanced quads that follow the terrain on the GPU
// =====================================================================================
export const DECAL = { fire: 0, ring: 1, telegraph: 2, aura: 3, progress: 4, glow: 5, target: 6, lane: 7, beam: 8, lit: 9 } as const;

export class Decals {
  readonly mesh: THREE.InstancedMesh;
  private max: number;
  private aPos: THREE.InstancedBufferAttribute; // x, z, type, lift
  private aAxis: THREE.InstancedBufferAttribute; // dirx, dirz, halfLen, halfWid
  private aCol: THREE.InstancedBufferAttribute; // rgb, alpha
  private aPar: THREE.InstancedBufferAttribute; // progress, seed, inner, unused
  private n = 0;

  constructor(max = 320) {
    this.max = max;
    const geo = new THREE.PlaneGeometry(2, 2, 14, 14);
    geo.rotateX(-Math.PI / 2);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.aAxis = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.aPar = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    for (const a of [this.aPos, this.aAxis, this.aCol, this.aPar]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aAxis', this.aAxis);
    geo.setAttribute('aCol', this.aCol);
    geo.setAttribute('aPar', this.aPar);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: shared.uTime, uHeightMap: shared.uHeightMap, uHeightExtent: shared.uHeightExtent },
      vertexShader: /* glsl */ `
        ${HEIGHT_GLSL}
        attribute vec4 aPos, aAxis, aCol, aPar;
        varying vec2 vL;
        varying vec4 vCol, vPar;
        varying float vType;
        varying vec2 vHalf;
        void main() {
          vL = position.xz;
          vCol = aCol; vPar = aPar; vType = aPos.z; vHalf = aAxis.zw;
          vec2 dir = aAxis.xy;
          vec2 perp = vec2(-dir.y, dir.x);
          vec2 xz = aPos.xy + dir * position.x * aAxis.z + perp * position.z * aAxis.w;
          float y = terrainH(xz) + 0.14 + aPos.w;
          gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, y, xz.y, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vL;
        varying vec4 vCol, vPar;
        varying float vType;
        varying vec2 vHalf;
        uniform float uTime;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        void main() {
          float r = length(vL);
          float ang = atan(vL.y, vL.x);
          float a = 0.0;
          vec3 col = vCol.rgb;
          int ty = int(vType + 0.5);
          float px = 1.0 / max(vHalf.x, 0.001); // one world unit in local space
          if (ty == 0) {
            // burning ground: flickering blotches, hot rim
            vec2 w = vL * vHalf.x;
            float n = noise(w * 1.6 + vec2(0.0, -uTime * 1.5) + vPar.y * 20.0) * 0.6 + noise(w * 3.4 + vec2(uTime * 0.8, uTime * 1.1)) * 0.4;
            float body = smoothstep(1.0, 0.25, r + (n - 0.5) * 0.5);
            a = body * (0.35 + n * 0.75) + smoothstep(0.2, 0.0, abs(r - 0.86)) * 0.35 * n;
            col = mix(col, vec3(1.0, 0.85, 0.5), n * n * 0.6);
          } else if (ty == 1) {
            // expanding shock ring
            float wdt = max(0.06, 0.5 * px);
            a = smoothstep(wdt, 0.0, abs(r - (1.0 - wdt))) + smoothstep(1.0, 0.2, r) * 0.12 * step(r, 1.0);
          } else if (ty == 2) {
            // hostile telegraph: rim + growing fill
            float rim = smoothstep(0.07, 0.0, abs(r - 0.95));
            float fill = step(r, vPar.x) * (0.25 + 0.2 * sin(uTime * 22.0));
            float edge = smoothstep(0.05, 0.0, abs(r - vPar.x)) * 0.8;
            a = (rim + fill + edge) * step(r, 1.0);
            a += step(r, 1.0) * 0.08;
          } else if (ty == 3) {
            // player aura: soft band with slowly rotating ticks
            float band = smoothstep(0.14, 0.0, abs(r - 0.92));
            float ticks = smoothstep(0.6, 1.0, sin(ang * 12.0 + uTime * 0.8)) * smoothstep(0.3, 0.0, abs(r - 0.78));
            a = band * 0.75 + ticks * 0.3 + smoothstep(1.0, 0.0, r) * 0.1 * step(r, 1.0);
          } else if (ty == 4) {
            // progress arc
            float band = smoothstep(0.05, 0.0, abs(r - 0.93));
            float frac = (ang + 3.14159265) / 6.2831853;
            float on = step(frac, vPar.x);
            a = band * (0.18 + on * 1.3) + smoothstep(0.03, 0.0, abs(r - 0.8)) * 0.15;
            a += on * smoothstep(0.93, 0.5, r) * step(r, 0.93) * 0.08;
          } else if (ty == 5) {
            // soft glow blob
            a = smoothstep(1.0, 0.0, r);
            a *= a;
          } else if (ty == 6) {
            // friendly strike marker: shrinking ring + crosshair
            float rr = mix(1.0, 0.25, vPar.x);
            a = smoothstep(0.07, 0.0, abs(r - rr)) + smoothstep(0.05, 0.0, abs(r - 0.96)) * 0.5;
            a += smoothstep(0.04, 0.0, min(abs(vL.x), abs(vL.y))) * step(r, 0.3) * 0.6;
          } else if (ty == 7) {
            // boss charge lane
            float edge = smoothstep(0.12, 0.0, 1.0 - abs(vL.y));
            float chev = smoothstep(0.7, 1.0, sin((vL.x * vHalf.x - abs(vL.y) * vHalf.y) * 1.6 - uTime * 14.0));
            a = edge * 0.9 + chev * 0.35 + 0.1;
            a *= smoothstep(1.0, 0.9, abs(vL.x));
          } else if (ty == 8) {
            // beam scorch
            float core = smoothstep(1.0, 0.0, abs(vL.y));
            a = core * core * smoothstep(1.0, 0.92, abs(vL.x)) ;
          } else {
            // lit beacon ground sigil
            float band = smoothstep(0.03, 0.0, abs(r - 0.95)) + smoothstep(0.02, 0.0, abs(r - 0.7)) * 0.5;
            float rays = smoothstep(0.75, 1.0, sin(ang * 8.0 - uTime * 0.35)) * smoothstep(0.7, 0.95, r) * step(r, 0.95);
            a = band + rays * 0.35 + smoothstep(1.0, 0.0, r) * 0.07 * step(r, 1.0);
          }
          a *= vCol.a;
          if (a < 0.003) discard;
          gl_FragColor = vec4(col * a, 1.0);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.count = 0;
  }

  begin() {
    this.n = 0;
  }

  /** circular decal */
  add(type: number, x: number, z: number, radius: number, r: number, g: number, b: number, alpha: number, progress = 0, seed = 0, lift = 0) {
    this.addRect(type, x, z, 1, 0, radius, radius, r, g, b, alpha, progress, seed, lift);
  }

  /** oriented rectangle decal: centre, unit direction, half length / half width */
  addRect(type: number, x: number, z: number, dx: number, dz: number, halfLen: number, halfWid: number, r: number, g: number, b: number, alpha: number, progress = 0, seed = 0, lift = 0) {
    if (this.n >= this.max) return;
    const i = this.n++ * 4;
    const p = this.aPos.array as Float32Array, ax = this.aAxis.array as Float32Array, c = this.aCol.array as Float32Array, pr = this.aPar.array as Float32Array;
    p[i] = x; p[i + 1] = z; p[i + 2] = type; p[i + 3] = lift;
    ax[i] = dx; ax[i + 1] = dz; ax[i + 2] = halfLen; ax[i + 3] = halfWid;
    c[i] = r; c[i + 1] = g; c[i + 2] = b; c[i + 3] = alpha;
    pr[i] = progress; pr[i + 1] = seed; pr[i + 2] = 0; pr[i + 3] = 0;
  }

  end() {
    this.mesh.count = this.n;
    this.aPos.needsUpdate = true;
    this.aAxis.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aPar.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// =====================================================================================
// Ribbons — lightning bolts and beams as camera-facing-ish flat strips
// =====================================================================================
interface Bolt {
  pts: Float32Array; // x,y,z triples
  n: number;
  t: number;
  dur: number;
  width: number;
  r: number;
  g: number;
  b: number;
  jag: number;
  seed: number;
}

export class Ribbons {
  readonly mesh: THREE.Mesh;
  private maxQuads: number;
  private pos: THREE.BufferAttribute;
  private col: THREE.BufferAttribute;
  private uv: THREE.BufferAttribute;
  private bolts: Bolt[] = [];

  constructor(maxQuads = 1400) {
    this.maxQuads = maxQuads;
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(maxQuads * 6 * 3), 3);
    this.col = new THREE.BufferAttribute(new Float32Array(maxQuads * 6 * 3), 3);
    this.uv = new THREE.BufferAttribute(new Float32Array(maxQuads * 6), 1);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.col.setUsage(THREE.DynamicDrawUsage);
    this.uv.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aCol', this.col);
    geo.setAttribute('aV', this.uv);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute vec3 aCol; attribute float aV;
        varying vec3 vCol; varying float vV;
        void main() { vCol = aCol; vV = aV; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol; varying float vV;
        void main() {
          float c = 1.0 - abs(vV);
          float a = c * c + smoothstep(0.6, 1.0, c) * 1.5;
          gl_FragColor = vec4(vCol * a, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    geo.setDrawRange(0, 0);
  }

  /** pts: world-space xyz polyline */
  add(pts: number[], width: number, r: number, g: number, b: number, dur: number, jag: number) {
    if (this.bolts.length > 60) this.bolts.shift();
    this.bolts.push({ pts: Float32Array.from(pts), n: pts.length / 3, t: 0, dur, width, r, g, b, jag, seed: Math.random() * 1000 });
  }

  update(dt: number, camPos: THREE.Vector3) {
    const pa = this.pos.array as Float32Array, ca = this.col.array as Float32Array, va = this.uv.array as Float32Array;
    let q = 0;
    const rnd = (s: number) => {
      const x = Math.sin(s * 127.1) * 43758.5453;
      return x - Math.floor(x) - 0.5;
    };
    for (let bi = this.bolts.length - 1; bi >= 0; bi--) {
      const b = this.bolts[bi];
      b.t += dt;
      if (b.t >= b.dur) {
        this.bolts.splice(bi, 1);
        continue;
      }
      const life = 1 - b.t / b.dur;
      const k = life * life * 1.6;
      // re-jitter a few times over the lifetime for a crackling look
      const phase = Math.floor(b.t / 0.045);
      const sub = b.jag > 0 ? 4 : 1;
      let px = b.pts[0], py = b.pts[1], pz = b.pts[2];
      for (let s = 1; s < b.n; s++) {
        const ex = b.pts[s * 3], ey = b.pts[s * 3 + 1], ez = b.pts[s * 3 + 2];
        const sx = px, sy = py, sz = pz;
        const segLen = Math.hypot(ex - sx, ez - sz) || 1;
        const nx = -(ez - sz) / segLen, nz = (ex - sx) / segLen;
        for (let u = 1; u <= sub; u++) {
          const f = u / sub;
          let cx = sx + (ex - sx) * f, cy = sy + (ey - sy) * f, cz = sz + (ez - sz) * f;
          if (u < sub) {
            const j = rnd(b.seed + s * 13.7 + u * 3.1 + phase * 7.3) * b.jag * Math.min(2.2, segLen * 0.35);
            cx += nx * j;
            cz += nz * j;
            cy += rnd(b.seed + s * 5.1 + u * 9.7 + phase) * b.jag * 0.5;
          }
          if (q < this.maxQuads) {
            // strip quad between (px,py,pz) and (cx,cy,cz), widened perpendicular to the segment in the ground plane
            const dx = cx - px, dz = cz - pz;
            const l = Math.hypot(dx, dz) || 1;
            // widen toward the camera-perpendicular so the strip stays readable from a tilted view
            let wx = (-dz / l) * b.width, wz = (dx / l) * b.width;
            const vy = (camPos.y - cy) * 0.0;
            void vy;
            const o = q * 18;
            const o1 = q * 6;
            pa[o] = px - wx; pa[o + 1] = py; pa[o + 2] = pz - wz;
            pa[o + 3] = px + wx; pa[o + 4] = py; pa[o + 5] = pz + wz;
            pa[o + 6] = cx + wx; pa[o + 7] = cy; pa[o + 8] = cz + wz;
            pa[o + 9] = px - wx; pa[o + 10] = py; pa[o + 11] = pz - wz;
            pa[o + 12] = cx + wx; pa[o + 13] = cy; pa[o + 14] = cz + wz;
            pa[o + 15] = cx - wx; pa[o + 16] = cy; pa[o + 17] = cz - wz;
            va[o1] = -1; va[o1 + 1] = 1; va[o1 + 2] = 1; va[o1 + 3] = -1; va[o1 + 4] = 1; va[o1 + 5] = -1;
            for (let v = 0; v < 6; v++) {
              ca[o + v * 3] = b.r * k; ca[o + v * 3 + 1] = b.g * k; ca[o + v * 3 + 2] = b.b * k;
            }
            q++;
            wx = wz = 0;
          }
          px = cx; py = cy; pz = cz;
        }
      }
    }
    this.mesh.geometry.setDrawRange(0, q * 6);
    this.pos.needsUpdate = true;
    this.col.needsUpdate = true;
    this.uv.needsUpdate = true;
  }

  clear() {
    this.bolts.length = 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// =====================================================================================
// Floating combat text + screen-space markers drawn on the 2D overlay canvas
// =====================================================================================
interface FloatText {
  x: number;
  y: number;
  z: number;
  text: string;
  color: string;
  size: number;
  t: number;
  dur: number;
  vx: number;
  /** running total for merged damage numbers (0 = plain text) */
  val: number;
  crit: boolean;
}

export class Overlay {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private texts: FloatText[] = [];
  private v = new THREE.Vector3();
  w = 1;
  h = 1;
  dpr = 1;
  enabled = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  resize(w: number, h: number, dpr: number) {
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  text(x: number, y: number, z: number, text: string, color: string, size: number, dur = 0.7) {
    if (!this.enabled) return;
    if (this.texts.length > 70) {
      // drop the smallest/oldest to make room
      let idx = 0, best = Infinity;
      for (let i = 0; i < this.texts.length; i++) {
        const s = this.texts[i].size - this.texts[i].t * 10;
        if (s < best) {
          best = s;
          idx = i;
        }
      }
      if (best > size) return;
      this.texts.splice(idx, 1);
    }
    this.texts.push({ x, y, z, text, color, size, t: 0, dur, vx: (Math.random() - 0.5) * 1.4, val: 0, crit: false });
  }

  /**
   * Damage number. Rapid hits on the same spot (beams, auras, burn ticks) add up into one growing number
   * instead of spraying dozens of tiny ones.
   */
  damage(x: number, y: number, z: number, dmg: number, crit: boolean) {
    if (!this.enabled) return;
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const f = this.texts[i];
      if (f.val <= 0 || f.t > 0.32) continue;
      const dx = f.x - x, dz = f.z - z;
      if (dx * dx + dz * dz > 1.0) continue;
      f.val += dmg;
      f.crit = f.crit || crit;
      f.text = String(Math.round(f.val)) + (f.crit ? '!' : '');
      f.size = (13 + Math.min(13, Math.sqrt(f.val) * 0.85)) * (f.crit ? 1.3 : 1);
      if (f.crit) f.color = '#ffd23a';
      // re-pop a little and follow the target
      f.t = Math.min(f.t, f.dur * 0.1);
      f.x = x;
      f.z = z;
      return;
    }
    const size = (13 + Math.min(11, Math.sqrt(dmg) * 0.85)) * (crit ? 1.3 : 1);
    this.text(x, y, z, String(Math.round(dmg)) + (crit ? '!' : ''), crit ? '#ffd23a' : '#f4f1ff', size, crit ? 0.85 : 0.6);
    const f = this.texts[this.texts.length - 1];
    if (f && f.t === 0 && f.x === x && f.z === z) {
      f.val = dmg;
      f.crit = crit;
    }
  }

  /** project world → css pixels; returns false if behind camera */
  project(cam: THREE.Camera, x: number, y: number, z: number, out: { x: number; y: number }): boolean {
    this.v.set(x, y, z).project(cam);
    out.x = (this.v.x * 0.5 + 0.5) * this.w;
    out.y = (-this.v.y * 0.5 + 0.5) * this.h;
    return this.v.z < 1;
  }

  clear() {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  drawTexts(cam: THREE.Camera, dt: number) {
    const ctx = this.ctx;
    const o = { x: 0, y: 0 };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const f = this.texts[i];
      f.t += dt;
      if (f.t >= f.dur) {
        this.texts.splice(i, 1);
        continue;
      }
      const k = f.t / f.dur;
      if (!this.project(cam, f.x + f.vx * k, f.y + 1.2 + k * 1.6, f.z, o)) continue;
      // pop in, then drift and fade
      const pop = k < 0.15 ? 0.6 + (k / 0.15) * 0.6 : 1.2 - Math.min(1, (k - 0.15) / 0.2) * 0.2;
      const size = f.size * pop;
      ctx.globalAlpha = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
      ctx.font = `800 ${size.toFixed(1)}px "Trebuchet MS", "Segoe UI", system-ui, sans-serif`;
      ctx.lineWidth = Math.max(2.5, size * 0.22);
      ctx.strokeStyle = 'rgba(8,6,16,0.85)';
      ctx.strokeText(f.text, o.x, o.y);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, o.x, o.y);
    }
    ctx.globalAlpha = 1;
  }

  reset() {
    this.texts.length = 0;
    this.clear();
  }
}
