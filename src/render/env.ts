import * as THREE from 'three';
import { Noise2D, clamp, lerp, smoothstep } from '../core/rng';
import { SEA_LEVEL, type BiomeId, type World } from '../sim/worldgen';
import { HEIGHT_GLSL, shared } from './materials';

export interface Palette {
  grassA: number; grassB: number; grassC: number; dirt: number; sand: number; rock: number;
  leafA: number; leafB: number; oakA: number; oakB: number; trunk: number; snow: number;
  stone: number; stoneDark: number; moss: number;
  crystal: number; shroomCap: number; shroomGlow: number; ice: number; cactus: number; bone: number;
  flowers: number[]; grassBlade: number; fern: number;
  skyTopN: number; skyHorN: number; skyTopD: number; skyHorD: number;
  fogN: number; fogD: number;
  waterDeep: number; waterShallow: number;
  hemiSkyN: number; hemiGroundN: number; hemiSkyD: number; hemiGroundD: number;
  moon: number; sun: number; aurora: number;
  firefly: number;
}

export const PALETTES: Record<BiomeId, Palette> = {
  ashwood: {
    grassA: 0x3d7a4c, grassB: 0x2d6a5c, grassC: 0x55823f, dirt: 0x6e5842, sand: 0xa39a72, rock: 0x666c7c,
    leafA: 0x2b6b56, leafB: 0x1f5a52, oakA: 0x4c8b4a, oakB: 0x3a7a5c, trunk: 0x4c3729, snow: 0,
    stone: 0x8b8e9c, stoneDark: 0x555868, moss: 0x4a7a44,
    crystal: 0x5ad8ff, shroomCap: 0x8a4a7a, shroomGlow: 0x6affd0, ice: 0xa8e4ff, cactus: 0x4a7a50, bone: 0xd8cdb8,
    flowers: [0xff8ad0, 0x8ad0ff, 0xffe08a, 0xb0ffb0], grassBlade: 0x4f9a58, fern: 0x3a8a60,
    skyTopN: 0x04061a, skyHorN: 0x16264f, skyTopD: 0x2f5aa8, skyHorD: 0xff9456,
    fogN: 0x0e1a36, fogD: 0xd98a66,
    waterDeep: 0x061226, waterShallow: 0x1a5a6a,
    hemiSkyN: 0x4a63b8, hemiGroundN: 0x141826, hemiSkyD: 0xbfd4ff, hemiGroundD: 0x6a5040,
    moon: 0x9fb8ff, sun: 0xffc890, aurora: 0x3affb0,
    firefly: 0xd8ff8a,
  },
  frostmere: {
    grassA: 0xd4e2f2, grassB: 0xb4c8e4, grassC: 0xe8f0fa, dirt: 0x76839a, sand: 0xc0cfe0, rock: 0x74819a,
    leafA: 0x2c5c66, leafB: 0x234e5c, oakA: 0x2c5c66, oakB: 0x234e5c, trunk: 0x3c323a, snow: 0xe6f0fc,
    stone: 0x8f9bb0, stoneDark: 0x566078, moss: 0xdce8f6,
    crystal: 0x9ac4ff, shroomCap: 0x5a6a9a, shroomGlow: 0x9ad8ff, ice: 0xa8e4ff, cactus: 0x4a7a50, bone: 0xd8cdb8,
    flowers: [0xbfe4ff, 0xe0d0ff, 0xffffff], grassBlade: 0x9fb8cc, fern: 0x7a9ab0,
    skyTopN: 0x030818, skyHorN: 0x1a3058, skyTopD: 0x4a78c0, skyHorD: 0xffb8a0,
    fogN: 0x152744, fogD: 0xf0c0b0,
    waterDeep: 0x04101f, waterShallow: 0x2a6a8a,
    hemiSkyN: 0x6a86d8, hemiGroundN: 0x1c2436, hemiSkyD: 0xd4e4ff, hemiGroundD: 0x8a8090,
    moon: 0xb8d0ff, sun: 0xffd0a8, aurora: 0x6ad8ff,
    firefly: 0xcfeaff,
  },
  emberwaste: {
    grassA: 0x8a4c38, grassB: 0x6e3c32, grassC: 0x9a5a3a, dirt: 0x4c2c28, sand: 0xa86a4c, rock: 0x3c2e32,
    leafA: 0x4a7a50, leafB: 0x3a6a48, oakA: 0x4a7a50, oakB: 0x3a6a48, trunk: 0x2c2226, snow: 0,
    stone: 0x7a6a66, stoneDark: 0x4a3c3c, moss: 0x6a3a2a,
    crystal: 0xff6a3a, shroomCap: 0x6a2a2a, shroomGlow: 0xffa04a, ice: 0xa8e4ff, cactus: 0x4c7c52, bone: 0xd8cdb8,
    flowers: [0xffb04a, 0xff6a4a, 0xffe08a], grassBlade: 0xa8744a, fern: 0x8a5a3a,
    skyTopN: 0x0c0410, skyHorN: 0x3a1420, skyTopD: 0x5a6ab0, skyHorD: 0xffb070,
    fogN: 0x22101a, fogD: 0xf0b088,
    waterDeep: 0x12060c, waterShallow: 0x6a2a1a,
    hemiSkyN: 0x8a5a78, hemiGroundN: 0x1c1014, hemiSkyD: 0xd4d4ff, hemiGroundD: 0x7a5040,
    moon: 0xffb4a0, sun: 0xffc890, aurora: 0xff5a3a,
    firefly: 0xffb060,
  },
  gloommire: {
    grassA: 0x2c5a5c, grassB: 0x3a4a72, grassC: 0x2a6a58, dirt: 0x3a3048, sand: 0x5a5a78, rock: 0x4a4868,
    leafA: 0x3a4a7a, leafB: 0x2c3c6a, oakA: 0x6a4a9a, oakB: 0x4a5aa0, trunk: 0x2c2438, snow: 0,
    stone: 0x7c7a9c, stoneDark: 0x4a4868, moss: 0x3a7a6a,
    crystal: 0xb98cff, shroomCap: 0x7a4ac0, shroomGlow: 0x8cff9a, ice: 0xa8e4ff, cactus: 0x4a7a50, bone: 0xd8cdb8,
    flowers: [0xb98cff, 0x8cffd0, 0xff8ae0, 0x8ab8ff], grassBlade: 0x3a8a80, fern: 0x4a6aa0,
    skyTopN: 0x07041c, skyHorN: 0x2a1c58, skyTopD: 0x4a5ab8, skyHorD: 0xffa0a8,
    fogN: 0x161236, fogD: 0xd89ab0,
    waterDeep: 0x0a0a26, waterShallow: 0x2a6a6a,
    hemiSkyN: 0x6a5ac0, hemiGroundN: 0x14162a, hemiSkyD: 0xc8d0ff, hemiGroundD: 0x5a4a60,
    moon: 0xc8b0ff, sun: 0xffc0a0, aurora: 0xa06aff,
    firefly: 0x9affc0,
  },
};

const HM_SIZE = 256;
export const HM_EXTENT = 176;

/** Bake terrain heights into a half-float texture so decals/water can hug the ground on the GPU. */
export function buildHeightTexture(world: World): THREE.DataTexture {
  const data = new Uint16Array(HM_SIZE * HM_SIZE);
  for (let j = 0; j < HM_SIZE; j++) {
    for (let i = 0; i < HM_SIZE; i++) {
      const x = ((i + 0.5) / HM_SIZE - 0.5) * 2 * HM_EXTENT;
      const z = ((j + 0.5) / HM_SIZE - 0.5) * 2 * HM_EXTENT;
      data[j * HM_SIZE + i] = THREE.DataUtils.toHalfFloat(world.height(x, z));
    }
  }
  const tex = new THREE.DataTexture(data, HM_SIZE, HM_SIZE, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export function buildTerrain(world: World, pal: Palette): THREE.Mesh {
  const size = (world.radius + 34) * 2;
  const seg = 230;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.getAttribute('position');
  const n = pos.count;
  const noise = new Noise2D(world.seed + 4242);
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const h = world.height(pos.getX(i), pos.getZ(i));
    heights[i] = h;
    pos.setY(i, h);
  }
  // non-indexed so every triangle can carry its own colour (crisp low-poly facets)
  const flat = geo.toNonIndexed();
  geo.dispose();
  const fp = flat.getAttribute('position');
  const fc = new Float32Array(fp.count * 3);
  const cA = new THREE.Color(pal.grassA), cB = new THREE.Color(pal.grassB), cC = new THREE.Color(pal.grassC);
  const cDirt = new THREE.Color(pal.dirt), cSand = new THREE.Color(pal.sand), cRock = new THREE.Color(pal.rock);
  const c = new THREE.Color();
  for (let t = 0; t < fp.count; t += 3) {
    const x = (fp.getX(t) + fp.getX(t + 1) + fp.getX(t + 2)) / 3;
    const z = (fp.getZ(t) + fp.getZ(t + 1) + fp.getZ(t + 2)) / 3;
    const y0 = fp.getY(t), y1 = fp.getY(t + 1), y2 = fp.getY(t + 2);
    const y = (y0 + y1 + y2) / 3;
    const slope = Math.max(y0, y1, y2) - Math.min(y0, y1, y2);
    const n1 = noise.fbm(x * 0.03, z * 0.03, 3) * 0.5 + 0.5;
    const n2 = noise.get(x * 0.35 + 30, z * 0.35 - 12) * 0.5 + 0.5;
    c.copy(cA).lerp(cB, smoothstep(0.3, 0.7, n1));
    c.lerp(cC, smoothstep(0.62, 0.9, n2) * 0.55);
    // paths and clearings
    const pd = world.pathDist(x, z);
    const cd = world.clearingDist(x, z);
    const dirt = Math.max(smoothstep(2.9, 1.1, pd + (n2 - 0.5) * 1.4), smoothstep(1.5, -3.5, cd + (n2 - 0.5) * 2.5) * 0.85);
    c.lerp(cDirt, dirt);
    // rocky slopes, sandy shore
    c.lerp(cRock, smoothstep(0.55, 1.1, slope) * 0.8);
    c.lerp(cSand, smoothstep(SEA_LEVEL + 2.3, SEA_LEVEL + 0.7, y));
    if (y < SEA_LEVEL) c.multiplyScalar(lerp(1, 0.35, clamp((SEA_LEVEL - y) / 4, 0, 1)));
    const j = 0.9 + ((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1) * 0.1 + n2 * 0.1;
    for (let k = 0; k < 3; k++) {
      fc[(t + k) * 3] = c.r * j;
      fc[(t + k) * 3 + 1] = c.g * j;
      fc[(t + k) * 3 + 2] = c.b * j;
    }
  }
  flat.setAttribute('color', new THREE.BufferAttribute(fc, 3));
  flat.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(flat, mat);
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// ---------------------------------------------------------------- water
function buildWater(pal: Palette): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(2400, 2400, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: shared.uTime,
      uHeightMap: shared.uHeightMap,
      uHeightExtent: shared.uHeightExtent,
      uSea: { value: SEA_LEVEL },
      uDeep: { value: new THREE.Color(pal.waterDeep) },
      uShallow: { value: new THREE.Color(pal.waterShallow) },
      uSky: { value: new THREE.Color(pal.skyHorN) },
      uFog: { value: new THREE.Color(pal.fogN) },
      uFogDensity: { value: 0.01 },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) },
      uLightCol: { value: new THREE.Color(pal.moon) },
      uDawn: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${HEIGHT_GLSL}
      varying vec3 vW;
      uniform float uTime, uSea, uFogDensity, uDawn;
      uniform vec3 uDeep, uShallow, uSky, uFog, uLightDir, uLightCol;
      void main() {
        vec2 p = vW.xz;
        float depth = uSea - terrainH(p);
        float t = uTime;
        vec2 n = vec2(0.0);
        n += vec2(cos(p.x * 0.33 + t * 0.9), cos(p.y * 0.29 + t * 0.7)) * 0.5;
        n += vec2(cos(p.x * 0.9 - p.y * 0.6 + t * 1.6), cos(p.y * 1.1 + p.x * 0.4 - t * 1.3)) * 0.32;
        n += vec2(cos(p.x * 2.3 + p.y * 1.1 + t * 2.1), cos(p.y * 2.7 - p.x * 0.7 - t * 1.9)) * 0.14;
        vec3 N = normalize(vec3(-n.x * 0.3, 1.0, -n.y * 0.3));
        vec3 V = normalize(cameraPosition - vW);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        vec3 col = mix(uDeep, uShallow, smoothstep(5.0, 0.0, depth) * 0.85);
        col = mix(col, uSky, clamp(fres, 0.0, 1.0) * 0.7);
        vec3 H = normalize(normalize(uLightDir) + V);
        float spec = pow(max(dot(N, H), 0.0), 90.0);
        col += uLightCol * spec * (1.2 + uDawn * 0.6);
        // animated shoreline foam
        float wob = sin(t * 1.3 + p.x * 0.45 + p.y * 0.38) * 0.22 + sin(t * 0.7 - p.x * 0.2 + p.y * 0.6) * 0.15;
        float foam = smoothstep(0.75, 0.05, depth + wob);
        float band = smoothstep(0.25, 0.0, abs(fract(depth * 0.55 - t * 0.22) - 0.5) - 0.12) * smoothstep(3.2, 0.6, depth);
        col = mix(col, vec3(0.75, 0.88, 0.95) * (0.45 + uDawn * 0.6), clamp(foam * 0.85 + band * 0.25, 0.0, 1.0));
        float d = length(vW - cameraPosition);
        float f = 1.0 - exp(-d * d * uFogDensity * uFogDensity);
        col = mix(col, uFog, f);
        float a = smoothstep(-0.05, 0.35, depth + wob * 0.5);
        gl_FragColor = vec4(col, a);
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.y = SEA_LEVEL;
  m.renderOrder = 1;
  m.frustumCulled = false;
  return m;
}

// ---------------------------------------------------------------- sky
function buildSky(pal: Palette): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1500, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: shared.uTime,
      uTop: { value: new THREE.Color(pal.skyTopN) },
      uHor: { value: new THREE.Color(pal.skyHorN) },
      uMoonDir: { value: new THREE.Vector3(-0.4, 0.55, -0.6).normalize() },
      uSunDir: { value: new THREE.Vector3(0.75, 0.08, 0.5).normalize() },
      uMoonCol: { value: new THREE.Color(pal.moon) },
      uSunCol: { value: new THREE.Color(pal.sun) },
      uAurora: { value: new THREE.Color(pal.aurora) },
      uDawn: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform float uTime, uDawn;
      uniform vec3 uTop, uHor, uMoonDir, uSunDir, uMoonCol, uSunCol, uAurora;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(vec3(i, 1.0)), b = hash(vec3(i + vec2(1, 0), 1.0)), c = hash(vec3(i + vec2(0, 1), 1.0)), d = hash(vec3(i + vec2(1, 1), 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 col = mix(uHor, uTop, pow(h, 0.5));
        col = mix(col, uHor * 0.55, smoothstep(0.0, -0.25, d.y));
        float night = 1.0 - uDawn;
        // stars
        vec3 g = d * 190.0;
        vec3 id = floor(g);
        float rnd = hash(id);
        float star = step(0.988, rnd) * smoothstep(0.42, 0.0, length(fract(g) - 0.5));
        star *= 0.55 + 0.45 * sin(uTime * 2.2 + rnd * 90.0);
        col += vec3(0.85, 0.92, 1.0) * star * night * night * smoothstep(0.02, 0.25, d.y) * 2.2;
        // moon with halo
        float md = max(dot(d, uMoonDir), 0.0);
        col += uMoonCol * (smoothstep(0.9982, 0.9989, md) * 3.0 + pow(md, 260.0) * 0.6 + pow(md, 14.0) * 0.14) * (1.0 - uDawn * 0.85);
        // aurora ribbons
        float ax = atan(d.z, d.x);
        float ribbon = noise(vec2(ax * 3.0 + uTime * 0.05, uTime * 0.03)) * 0.35 + 0.22;
        float au = smoothstep(0.16, 0.0, abs(d.y - ribbon)) * noise(vec2(ax * 14.0 - uTime * 0.2, d.y * 6.0));
        float rays = noise(vec2(ax * 40.0, uTime * 0.25)) * 0.6 + 0.4;
        col += uAurora * au * rays * night * 0.75;
        // drifting cloud bands near the horizon
        float cl = noise(vec2(ax * 5.0 + uTime * 0.012, d.y * 18.0)) * noise(vec2(ax * 11.0 - uTime * 0.02, d.y * 9.0 + 4.0));
        float clm = smoothstep(0.32, 0.6, cl) * smoothstep(0.42, 0.06, abs(d.y - 0.12));
        col = mix(col, mix(uHor * 1.5, uSunCol, uDawn * 0.8), clm * (0.25 + uDawn * 0.45));
        // sunrise
        float sd = max(dot(d, uSunDir), 0.0);
        col += uSunCol * (pow(sd, 5.0) * 0.22 + pow(sd, 40.0) * 0.4 + smoothstep(0.9990, 0.9996, sd) * 2.6) * uDawn;
        col += uSunCol * smoothstep(0.3, 0.0, abs(d.y)) * uDawn * 0.12;
        // keep the sky itself under the bloom threshold; only the sun disc may exceed it
        col = min(col, vec3(0.86) + smoothstep(0.9985, 0.9996, sd) * 3.0 * uDawn);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}

/** Sky, water, lights and fog. Owns the night→dawn blend. */
export class Environment {
  readonly group = new THREE.Group();
  readonly sky: THREE.Mesh;
  readonly water: THREE.Mesh;
  readonly hemi: THREE.HemisphereLight;
  readonly moon: THREE.DirectionalLight;
  readonly fog: THREE.FogExp2;
  dawn = 0;
  private pal: Palette;
  private moonDir = new THREE.Vector3(-0.42, 0.72, -0.55).normalize();
  private sunDir = new THREE.Vector3(0.75, 0.3, 0.5).normalize();
  private tmpA = new THREE.Color();
  private tmpB = new THREE.Color();
  private lightDir = new THREE.Vector3();

  constructor(pal: Palette, shadows: boolean, shadowSize: number) {
    this.pal = pal;
    this.sky = buildSky(pal);
    this.water = buildWater(pal);
    this.hemi = new THREE.HemisphereLight(pal.hemiSkyN, pal.hemiGroundN, 1.0);
    this.moon = new THREE.DirectionalLight(pal.moon, 1.2);
    this.moon.castShadow = shadows;
    if (shadows) {
      const s = this.moon.shadow;
      s.mapSize.set(shadowSize, shadowSize);
      s.camera.left = -46;
      s.camera.right = 46;
      s.camera.top = 46;
      s.camera.bottom = -46;
      s.camera.near = 10;
      s.camera.far = 260;
      s.bias = -0.0006;
      s.normalBias = 0.05;
      s.intensity = 0.78;
    }
    this.fog = new THREE.FogExp2(pal.fogN, 0.012);
    this.group.add(this.sky, this.water, this.hemi, this.moon, this.moon.target);
    this.apply(0, new THREE.Vector3());
  }

  /** dawn in [0,1]; focus = point the shadow frustum should follow */
  apply(dawn: number, focus: THREE.Vector3) {
    this.dawn = dawn;
    const p = this.pal;
    const d = smoothstep(0, 1, dawn);
    const skyU = (this.sky.material as THREE.ShaderMaterial).uniforms;
    const watU = (this.water.material as THREE.ShaderMaterial).uniforms;
    skyU.uTop.value.copy(this.tmpA.setHex(p.skyTopN)).lerp(this.tmpB.setHex(p.skyTopD), d);
    skyU.uHor.value.copy(this.tmpA.setHex(p.skyHorN)).lerp(this.tmpB.setHex(p.skyHorD), d);
    skyU.uDawn.value = d;
    skyU.uSunDir.value.copy(this.sunDir).setY(lerp(-0.06, 0.12, d)).normalize();
    this.fog.color.copy(this.tmpA.setHex(p.fogN)).lerp(this.tmpB.setHex(p.fogD), d);
    this.fog.density = lerp(0.0125, 0.0042, d);
    this.hemi.color.copy(this.tmpA.setHex(p.hemiSkyN)).lerp(this.tmpB.setHex(p.hemiSkyD), d);
    this.hemi.groundColor.copy(this.tmpA.setHex(p.hemiGroundN)).lerp(this.tmpB.setHex(p.hemiGroundD), d);
    this.hemi.intensity = lerp(1.9, 1.05, d);
    this.moon.color.copy(this.tmpA.setHex(p.moon)).lerp(this.tmpB.setHex(p.sun), d);
    this.moon.intensity = lerp(2.6, 1.9, d);
    this.lightDir.copy(this.moonDir).lerp(this.sunDir, d).normalize();
    this.moon.position.copy(focus).addScaledVector(this.lightDir, 130);
    this.moon.target.position.copy(focus);
    this.moon.target.updateMatrixWorld();
    watU.uSky.value.copy(skyU.uHor.value);
    watU.uFog.value.copy(this.fog.color);
    watU.uFogDensity.value = this.fog.density;
    watU.uLightDir.value.copy(this.lightDir);
    watU.uLightCol.value.copy(this.moon.color);
    watU.uDawn.value = d;
  }

  dispose() {
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.water.geometry.dispose();
    (this.water.material as THREE.Material).dispose();
    this.moon.shadow.map?.dispose();
  }
}
