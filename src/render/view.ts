import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, damp, lerp, TAU } from '../core/rng';
import type { CharDef, WeaponId } from '../sim/defs';
import { EVOLVED_LEVEL, WEAPONS } from '../sim/defs';
import type { Sim } from '../sim/sim';
import type { SimEvent } from '../sim/types';
import { SEA_LEVEL, type World } from '../sim/worldgen';
import { wstats } from '../sim/weapons';
import { Environment, PALETTES, buildTerrain, type Palette } from './env';
import { buildProps, type PropsResult } from './props';
import { EnemyRenderer, KIND_COLOR, PlayerModel } from './actors';
import { DECAL, Decals, Overlay, Particles, Ribbons } from './fx';
import { glowMat, makeWorldMat, shared } from './materials';
import * as G from './geo';

export type QualityId = 'low' | 'medium' | 'high' | 'ultra';
interface QualityDef {
  pr: number;
  shadows: boolean;
  shadowSize: number;
  bloom: boolean;
  msaa: number;
  decor: number;
  particles: number;
}
export const QUALITY: Record<QualityId, QualityDef> = {
  low: { pr: 1, shadows: false, shadowSize: 512, bloom: false, msaa: 0, decor: 0.22, particles: 0.5 },
  medium: { pr: 1.25, shadows: true, shadowSize: 1024, bloom: true, msaa: 0, decor: 0.55, particles: 0.8 },
  high: { pr: 1.5, shadows: true, shadowSize: 2048, bloom: true, msaa: 4, decor: 1, particles: 1 },
  ultra: { pr: 2, shadows: true, shadowSize: 4096, bloom: true, msaa: 4, decor: 1, particles: 1 },
};

const HF_N = 256;
const HF_EXT = 176;

/** CPU + GPU copy of the terrain height for fast lookups. */
class HeightField {
  readonly data = new Float32Array(HF_N * HF_N);
  readonly tex: THREE.DataTexture;
  constructor(world: World) {
    const half = new Uint16Array(HF_N * HF_N);
    for (let j = 0; j < HF_N; j++) {
      for (let i = 0; i < HF_N; i++) {
        const x = ((i + 0.5) / HF_N - 0.5) * 2 * HF_EXT;
        const z = ((j + 0.5) / HF_N - 0.5) * 2 * HF_EXT;
        const h = world.height(x, z);
        this.data[j * HF_N + i] = h;
        half[j * HF_N + i] = THREE.DataUtils.toHalfFloat(h);
      }
    }
    this.tex = new THREE.DataTexture(half, HF_N, HF_N, THREE.RedFormat, THREE.HalfFloatType);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
  }
  get = (x: number, z: number): number => {
    const fx = clamp((x / (2 * HF_EXT) + 0.5) * HF_N - 0.5, 0, HF_N - 1.001);
    const fz = clamp((z / (2 * HF_EXT) + 0.5) * HF_N - 0.5, 0, HF_N - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const d = this.data;
    const a = d[iz * HF_N + ix], b = d[iz * HF_N + ix + 1], c = d[(iz + 1) * HF_N + ix], e = d[(iz + 1) * HF_N + ix + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (e - c) * tx) * tz;
  };
}

/** Thin wrapper for per-frame rebuilt instanced meshes. */
class Inst {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private cap: number;
  private m: Float32Array;
  private c: Float32Array | null = null;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, colored: boolean) {
    this.cap = cap;
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.m = this.mesh.instanceMatrix.array as Float32Array;
    if (colored) {
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.c = this.mesh.instanceColor.array as Float32Array;
    }
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
  }
  begin() {
    this.n = 0;
  }
  add(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, r = 1, g = 1, b = 1) {
    if (this.n >= this.cap) return;
    const o = this.n * 16;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const m = this.m;
    m[o] = c * sx; m[o + 1] = 0; m[o + 2] = -s * sx; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = s * sz; m[o + 9] = 0; m[o + 10] = c * sz; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    if (this.c) {
      const k = this.n * 3;
      this.c[k] = r; this.c[k + 1] = g; this.c[k + 2] = b;
    }
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }
  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

interface RingFx {
  x: number; z: number; r0: number; r1: number; t: number; dur: number; r: number; g: number; b: number; type: number;
}
interface BeaconDyn {
  crystal: THREE.Mesh;
  pillar: THREE.Mesh;
  lit: number; // 0..1 animation
  y: number;
}
interface FlashLight {
  light: THREE.PointLight;
  t: number;
  dur: number;
  peak: number;
}

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.75 },
    uHurt: { value: 0 },
    uLowHp: { value: 0 },
    uAberr: { value: 0 },
    uFlash: { value: 0 },
    uSat: { value: 1.08 },
    uTime: { value: 0 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette, uHurt, uLowHp, uAberr, uFlash, uSat, uTime;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * (uAberr + 0.0015) * (0.4 + r2 * 3.0);
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSat - uLowHp * 0.35);
      col *= uTint;
      float vig = smoothstep(1.05, 0.3, length(c) * 1.42);
      col *= mix(1.0, vig, uVignette);
      float edge = smoothstep(0.22, 0.8, r2 * 1.7);
      col += vec3(0.85, 0.04, 0.06) * edge * (uHurt + uLowHp * (0.22 + 0.1 * sin(uTime * 5.0)));
      col += vec3(1.0, 0.92, 0.8) * uFlash;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const AFFIX_COLOR: Record<number, string> = { 1: '#6cf2ff', 2: '#7dff9b', 3: '#ff6a5a', 4: '#ffe36b', 5: '#c8d2e6' };

const WCOL: Record<WeaponId, [number, number, number]> = {
  ember: [1.0, 0.5, 0.15], wisps: [0.4, 0.9, 1.0], nova: [1.0, 0.6, 0.2], arc: [0.6, 0.8, 1.0], starfall: [1.0, 0.85, 0.45], sigil: [0.78, 0.6, 1.0], sprite: [1.0, 0.9, 0.55], totem: [1.0, 0.7, 0.4],
  lance: [1.0, 0.95, 0.7], frost: [0.55, 0.9, 1.0], darts: [0.75, 0.55, 1.0], trail: [1.0, 0.4, 0.12], aura: [1.0, 0.85, 0.5], glaive: [0.8, 0.88, 1.0],
};

export class GameView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.5, 2500);
  readonly overlay: Overlay;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private final: ShaderPass;
  private renderPass: RenderPass;
  quality: QualityId = 'high';
  private q: QualityDef = QUALITY.high;

  // world
  world: World | null = null;
  private pal: Palette = PALETTES.ashwood;
  private worldGroup = new THREE.Group();
  private env: Environment | null = null;
  private terrain: THREE.Mesh | null = null;
  private props: PropsResult | null = null;
  private hf: HeightField | null = null;
  private char: CharDef | null = null;
  height: (x: number, z: number) => number = () => 0;

  // actors
  private player: PlayerModel | null = null;
  private enemies: EnemyRenderer | null = null;
  private sim: Sim | null = null;

  // fx
  private sparks: Particles;
  private smoke: Particles;
  private decals: Decals;
  private ribbons: Ribbons;
  private rings: RingFx[] = [];
  private flashes: FlashLight[] = [];
  private siteLights: THREE.PointLight[] = [];
  private beaconDyn: BeaconDyn[] = [];
  private shrineDyn: { crystal: THREE.Mesh; beam: THREE.Mesh; y: number; fade: number }[] = [];
  private hearthFlame = 0;
  private bossHalo: THREE.Mesh;
  private bossRing: THREE.Mesh;

  // instanced visuals
  private iEmber: Inst; private iFrost: Inst; private iDart: Inst; private iGlaive: Inst; private iBullet: Inst; private iWisp: Inst; private iMeteor: Inst;
  private iGem: Inst; private iHeart: Inst; private iMagnet: Inst; private iCoin: Inst; private iChest: Inst;
  private pickupMat: THREE.MeshLambertMaterial;
  private fxGroup = new THREE.Group();

  // camera
  mode: 'menu' | 'follow' | 'victory' | 'death' = 'menu';
  private camTarget = new THREE.Vector3();
  private camPos = new THREE.Vector3(0, 30, 30);
  private lookAt = new THREE.Vector3();
  zoom = 1;
  /** cinematic focus point and weight (0 = follow the player) */
  focusX = 0;
  focusZ = 0;
  focusW = 0;
  private trauma = 0;
  shakeMul = 1;
  /** 1 = full-strength screen flashes, lower for the reduce-flash option */
  flashMul = 1;
  /** high-contrast colours for enemy attacks */
  assist = false;
  showDamage = true;
  /** supplied by the app so the renderer stays free of i18n */
  affixLabel: ((affix: number) => string) | null = null;
  private modeT = 0;
  private dawn = 0;
  private hurt = 0;
  private flash = 0;
  private aberr = 0;
  private fovKick = 0;
  /** beacon-lit camera beat: seconds since the last beacon caught fire (large = idle) and where it is */
  private litT = 99;
  private litX = 0;
  private litZ = 0;
  time = 0;
  private fxBudget = 0;
  private ambientT = 0;
  /** main loop reads and clears this to apply hit-stop */
  hitStop = 0;
  private ray = new THREE.Raycaster();
  private v2 = new THREE.Vector2();
  private v3 = new THREE.Vector3();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private w = 1;
  private h = 1;

  constructor(canvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x05060f);
    this.overlay = new Overlay(overlayCanvas);
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.55, 1.0);
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.final);
    this.composer.addPass(new OutputPass());

    this.sparks = new Particles(7000, true);
    this.smoke = new Particles(1500, false);
    this.decals = new Decals(360);
    this.ribbons = new Ribbons(1400);
    this.scene.add(this.worldGroup, this.fxGroup);
    this.fxGroup.add(this.decals.mesh, this.smoke.points, this.sparks.points, this.ribbons.mesh);

    // projectile / pickup instancers (shared across runs)
    const oct = (sx: number, sy: number, sz: number) => new THREE.OctahedronGeometry(0.5, 0).scale(sx, sy, sz);
    const white = () => glowMat(1, 1, 1);
    this.iEmber = new Inst(oct(1.9, 0.62, 0.62), white(), 400, true);
    this.iFrost = new Inst(oct(2.4, 0.4, 0.55), white(), 500, true);
    this.iDart = new Inst(new THREE.ConeGeometry(0.28, 1.1, 4).rotateZ(-Math.PI / 2), white(), 200, true);
    const blade = mergeGeometries([
      new THREE.BoxGeometry(2.1, 0.07, 0.34), new THREE.BoxGeometry(0.34, 0.07, 2.1), new THREE.TorusGeometry(0.42, 0.09, 4, 10).rotateX(Math.PI / 2),
    ])!;
    this.iGlaive = new Inst(blade, white(), 40, true);
    this.iBullet = new Inst(new THREE.IcosahedronGeometry(0.5, 1), white(), 700, true);
    this.iWisp = new Inst(new THREE.IcosahedronGeometry(0.5, 1), white(), 48, true);
    this.iMeteor = new Inst(new THREE.IcosahedronGeometry(0.55, 1), white(), 64, true);
    this.pickupMat = makeWorldMat();
    this.iGem = new Inst(G.geoGem(), this.pickupMat, 700, true);
    this.iHeart = new Inst(G.geoHeart(), this.pickupMat, 40, true);
    this.iMagnet = new Inst(G.geoMagnet(), this.pickupMat, 20, true);
    this.iCoin = new Inst(G.geoCoin(), this.pickupMat, 200, true);
    this.iChest = new Inst(G.geoChest(), this.pickupMat, 20, true);
    for (const i of [this.iEmber, this.iFrost, this.iDart, this.iGlaive, this.iBullet, this.iWisp, this.iMeteor, this.iGem, this.iHeart, this.iMagnet, this.iCoin, this.iChest]) this.fxGroup.add(i.mesh);
    this.iChest.mesh.castShadow = true;

    // pooled lights: fixed count so shaders never recompile mid-run
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffa050, 0, 46, 1.5);
      this.siteLights.push(l);
      this.scene.add(l);
    }
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 30, 1.6);
      this.flashes.push({ light: l, t: 1, dur: 1, peak: 0 });
      this.scene.add(l);
    }

    // boss dressing: halo sprite + rotating thorn ring
    const haloMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: shared.uTime, uCol: { value: new THREE.Color(1.0, 0.35, 0.15) }, uPow: { value: 1 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform float uTime, uPow; uniform vec3 uCol;
        void main() {
          vec2 c = vUv - 0.5; float r = length(c) * 2.0; float a = atan(c.y, c.x);
          float corona = pow(smoothstep(1.0, 0.44, r), 3.0) * smoothstep(0.38, 0.46, r);
          float rays = 0.55 + 0.45 * sin(a * 9.0 + uTime * 0.8) * sin(a * 5.0 - uTime * 0.5);
          float rim = smoothstep(0.035, 0.0, abs(r - 0.455)) * 2.4;
          gl_FragColor = vec4(uCol * (corona * rays * 1.6 + rim) * uPow, 1.0);
        }`,
    });
    this.bossHalo = new THREE.Mesh(new THREE.PlaneGeometry(13, 13), haloMat);
    this.bossHalo.visible = false;
    this.bossHalo.renderOrder = 4;
    const ringGeo = new THREE.TorusGeometry(3.6, 0.08, 4, 40);
    this.bossRing = new THREE.Mesh(ringGeo, glowMat(1.8, 0.45, 0.2));
    this.bossRing.visible = false;
    this.fxGroup.add(this.bossHalo, this.bossRing);
    this.setQuality('high');
  }

  // ------------------------------------------------------------------ setup
  setQuality(q: QualityId) {
    const changed = q !== this.quality;
    this.quality = q;
    this.q = QUALITY[q];
    this.bloom.enabled = this.q.bloom;
    this.renderer.shadowMap.enabled = this.q.shadows;
    this.sparks.density = this.q.particles;
    this.smoke.density = this.q.particles;
    this.resize(this.w, this.h);
    if (changed && this.world && this.char) {
      const sim = this.sim;
      this.loadWorld(this.world, this.char);
      this.sim = sim;
    }
  }

  resize(w: number, h: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    const pr = Math.min(window.devicePixelRatio || 1, this.q.pr);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.w, this.h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(this.w, this.h);
    const rt = this.composer.renderTarget1, rt2 = this.composer.renderTarget2;
    if (rt.samples !== this.q.msaa) {
      rt.samples = this.q.msaa;
      rt2.samples = this.q.msaa;
      rt.dispose();
      rt2.dispose();
    }
    this.camera.aspect = this.w / this.h;
    // keep a comfortable horizontal view on narrow / portrait screens
    this.camera.fov = this.camera.aspect < 1.2 ? lerp(58, 40, clamp((this.camera.aspect - 0.5) / 0.7, 0, 1)) : 40;
    this.camera.updateProjectionMatrix();
    this.sparks.setScale(this.h * pr, this.camera.fov);
    this.smoke.setScale(this.h * pr, this.camera.fov);
    this.overlay.resize(this.w, this.h, Math.min(window.devicePixelRatio || 1, 2));
  }

  loadWorld(world: World, char: CharDef) {
    this.disposeWorld();
    this.world = world;
    this.char = char;
    this.pal = PALETTES[world.biome.id];
    this.hf = new HeightField(world);
    this.height = this.hf.get;
    shared.uHeightMap.value = this.hf.tex;
    shared.uHeightExtent.value = HF_EXT;
    this.env = new Environment(this.pal, this.q.shadows, this.q.shadowSize);
    this.scene.fog = this.env.fog;
    this.terrain = buildTerrain(world, this.pal);
    this.props = buildProps(world, this.pal, { shadows: this.q.shadows, decorDensity: this.q.decor });
    this.worldGroup.add(this.env.group, this.terrain, this.props.group);
    this.player = new PlayerModel(char, this.q.shadows);
    this.enemies = new EnemyRenderer(this.q.shadows);
    this.worldGroup.add(this.player.root, this.enemies.group);
    // beacon dynamics
    const pillarMat = () => new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      uniforms: { uTime: shared.uTime, uPow: { value: 0 }, uCol: { value: new THREE.Color(1.0, 0.62, 0.25) } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform float uTime, uPow; uniform vec3 uCol;
        void main() {
          float v = vUv.y;
          float a = pow(1.0 - v, 2.2) * (0.75 + 0.25 * sin(vUv.x * 50.0 + uTime * 1.5 + v * 20.0));
          a += pow(1.0 - v, 12.0) * 1.5;
          gl_FragColor = vec4(uCol * a * uPow, 1.0);
        }`,
    });
    const crystalGeo = new THREE.OctahedronGeometry(0.62, 0).scale(1, 1.7, 1);
    const pillarGeo = new THREE.CylinderGeometry(0.7, 1.5, 150, 14, 1, true).translate(0, 75, 0);
    this.beaconDyn = world.beacons.map((b) => {
      const y = world.height(b.x, b.z);
      const crystal = new THREE.Mesh(crystalGeo, glowMat(0.3, 0.6, 1.4));
      crystal.position.set(b.x, y + 5.6, b.z);
      const pillar = new THREE.Mesh(pillarGeo, pillarMat());
      pillar.position.set(b.x, y + 4.4, b.z);
      pillar.visible = false;
      pillar.frustumCulled = false;
      this.worldGroup.add(crystal, pillar);
      return { crystal, pillar, lit: 0, y };
    });
    const shrineBeamGeo = new THREE.CylinderGeometry(0.25, 0.6, 26, 10, 1, true).translate(0, 13, 0);
    // shrine crystals hover over their altars until the bargain is struck
    this.shrineDyn = world.shrines.map((s) => {
      const y = world.height(s.x, s.z);
      const crystal = new THREE.Mesh(crystalGeo, glowMat(0.8, 0.5, 1.6));
      crystal.scale.setScalar(0.6);
      crystal.position.set(s.x, y + 2.2, s.z);
      // a thin violet shaft so a shrine can be spotted over the treetops
      const beam = new THREE.Mesh(shrineBeamGeo, pillarMat());
      const bm = beam.material as THREE.ShaderMaterial;
      (bm.uniforms.uCol.value as THREE.Color).setRGB(0.62, 0.42, 1.0);
      bm.uniforms.uPow.value = 0.35;
      beam.position.set(s.x, y + 1.5, s.z);
      beam.frustumCulled = false;
      this.worldGroup.add(crystal, beam);
      return { crystal, beam, y, fade: 1 };
    });
    this.sparks.clear();
    this.smoke.clear();
    this.ribbons.clear();
    this.rings.length = 0;
    this.overlay.reset();
    this.dawn = 0;
    this.trauma = 0;
    this.hurt = 0;
    this.flash = 0;
    this.litT = 99;
    this.camTarget.set(0, this.height(0, 0), 0);
  }

  private disposeWorld() {
    if (!this.world) return;
    this.worldGroup.clear();
    this.env?.dispose();
    this.terrain?.geometry.dispose();
    (this.terrain?.material as THREE.Material | undefined)?.dispose();
    this.props?.dispose();
    this.player?.dispose();
    this.enemies?.dispose();
    this.hf?.tex.dispose();
    if (this.beaconDyn.length) {
      this.beaconDyn[0].crystal.geometry.dispose();
      this.beaconDyn[0].pillar.geometry.dispose();
      for (const b of this.beaconDyn) {
        (b.crystal.material as THREE.Material).dispose();
        (b.pillar.material as THREE.Material).dispose();
      }
    }
    this.beaconDyn = [];
    if (this.shrineDyn.length) this.shrineDyn[0].beam.geometry.dispose();
    for (const s of this.shrineDyn) {
      (s.crystal.material as THREE.Material).dispose();
      (s.beam.material as THREE.Material).dispose();
    }
    this.shrineDyn = [];
    this.env = null;
    this.terrain = null;
    this.props = null;
    this.player = null;
    this.enemies = null;
    this.hf = null;
    this.world = null;
  }

  setSim(sim: Sim | null) {
    this.sim = sim;
    this.modeT = 0;
    if (sim) {
      this.camTarget.set(sim.player.x, this.height(sim.player.x, sim.player.z), sim.player.z);
    }
  }

  setMode(m: GameView['mode']) {
    if (m !== this.mode) {
      this.mode = m;
      this.modeT = 0;
    }
  }

  /** world xz under a screen position (css px), on the plane at the player's feet */
  groundPoint(cx: number, cy: number, out: { x: number; z: number }): boolean {
    this.v2.set((cx / this.w) * 2 - 1, -(cy / this.h) * 2 + 1);
    this.ray.setFromCamera(this.v2, this.camera);
    const py = this.sim ? this.height(this.sim.player.x, this.sim.player.z) + 0.9 : 0;
    this.plane.constant = -py;
    const hit = this.ray.ray.intersectPlane(this.plane, this.v3);
    if (!hit) return false;
    out.x = hit.x;
    out.z = hit.z;
    return true;
  }

  // ------------------------------------------------------------------ fx helpers
  addShake(v: number) {
    this.trauma = Math.min(1, this.trauma + v);
  }

  private ring(x: number, z: number, r0: number, r1: number, dur: number, r: number, g: number, b: number, type: number = DECAL.ring) {
    if (this.rings.length > 80) this.rings.shift();
    this.rings.push({ x, z, r0, r1, t: 0, dur, r, g, b, type });
  }

  private flashLight(x: number, y: number, z: number, r: number, g: number, b: number, peak: number, dur: number) {
    let best = this.flashes[0];
    for (const f of this.flashes) if (f.t / f.dur > best.t / best.dur) best = f;
    best.light.position.set(x, y, z);
    best.light.color.setRGB(r, g, b);
    best.t = 0;
    best.dur = dur;
    best.peak = peak * 0.32 * (0.35 + 0.65 * this.flashMul);
  }

  private burst(x: number, y: number, z: number, n: number, speed: number, life: number, size: number, r: number, g: number, b: number, up = 0.5, grav = 6, drag = 2) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const el = (Math.random() - 0.5 + up) * 1.6;
      const s = speed * (0.35 + Math.random() * 0.65);
      const k = 0.6 + Math.random() * 0.6;
      this.sparks.spawn(x, y, z, Math.cos(a) * s, el * s, Math.sin(a) * s, life * (0.6 + Math.random() * 0.6), size * (0.6 + Math.random() * 0.7), r * k, g * k, b * k, { grav, drag });
    }
  }

  private puff(x: number, y: number, z: number, n: number, size: number, shade: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const s = 0.6 + Math.random() * 1.6;
      const c = shade * (0.7 + Math.random() * 0.5);
      this.smoke.spawn(x + Math.cos(a) * 0.2, y + Math.random() * 0.6, z + Math.sin(a) * 0.2, Math.cos(a) * s, 0.8 + Math.random() * 1.4, Math.sin(a) * s, 0.5 + Math.random() * 0.45, size * (0.5 + Math.random() * 0.4), c * 0.9, c * 0.75, c * 1.2, { drag: 2.5, size1: size * 1.6 });
    }
  }

  handleEvents(events: SimEvent[]) {
    const sim = this.sim;
    if (!sim) return;
    const H = this.height;
    const p = sim.player;
    let hitFx = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      switch (ev.t) {
        case 'hit': {
          const y = H(ev.x, ev.z) + 1;
          const c = ev.w ? WCOL[ev.w] : ([1, 0.6, 0.25] as [number, number, number]);
          if (hitFx < 36) {
            hitFx++;
            this.burst(ev.x, y, ev.z, ev.crit ? 6 : 3, ev.crit ? 9 : 6, 0.28, ev.crit ? 0.55 : 0.4, c[0] * 2, c[1] * 2, c[2] * 2, 0.5, 10, 3);
          }
          if (this.showDamage && ev.dmg >= 1 && (hitFx < 30 || ev.crit || ev.big)) this.overlay.damage(ev.x, y + 0.6, ev.z, ev.dmg, ev.crit);
          break;
        }
        case 'kill': {
          const y = H(ev.x, ev.z);
          const c = KIND_COLOR[ev.kind];
          const big = ev.elite;
          this.enemies?.addCorpse(ev.kind, ev.x, ev.z, ev.face, ev.scale);
          this.puff(ev.x, y + 0.4, ev.z, big ? 14 : 5, ev.r * 2.6 + 0.8, 0.09);
          this.burst(ev.x, y + 0.8, ev.z, big ? 28 : 7, big ? 12 : 6.5, 0.55, big ? 0.7 : 0.45, c[0] * 2.4, c[1] * 2.4, c[2] * 2.4, 0.9, 9, 1.6);
          this.ring(ev.x, ev.z, ev.r * 0.6, ev.r * 2.6 + (big ? 3 : 0.6), big ? 0.5 : 0.28, c[0], c[1], c[2]);
          if (big) {
            this.addShake(0.35);
            this.flashLight(ev.x, y + 2, ev.z, c[0], c[1], c[2], 90, 0.4);
            this.hitStop = Math.max(this.hitStop, 0.05);
          }
          break;
        }
        case 'explode': {
          const y = H(ev.x, ev.z);
          const col = new THREE.Color(ev.c);
          this.ring(ev.x, ev.z, ev.r * 0.3, ev.r, 0.32, col.r * 1.6, col.g * 1.6, col.b * 1.6);
          this.ring(ev.x, ev.z, 0, ev.r * 0.9, 0.45, col.r, col.g, col.b, DECAL.glow);
          this.burst(ev.x, y + 0.6, ev.z, Math.min(40, 10 + ev.r * 5), 5 + ev.r * 2.2, 0.55, 0.6, col.r * 3, col.g * 3, col.b * 3, 0.8, 8, 2);
          this.puff(ev.x, y + 0.3, ev.z, 4, ev.r * 1.1, ev.hostile ? 0.1 : 0.16);
          const d = Math.hypot(ev.x - p.x, ev.z - p.z);
          if (d < 26) {
            this.addShake((ev.hostile ? 0.3 : 0.1) * clamp(ev.r / 4, 0.3, 1.5) * (1 - d / 30));
            this.flashLight(ev.x, y + 1.5, ev.z, col.r, col.g, col.b, 50 + ev.r * 14, 0.3);
          }
          break;
        }
        case 'lightning': {
          const pts: number[] = [];
          for (let k = 0; k < ev.pts.length; k += 2) {
            const x = ev.pts[k], z = ev.pts[k + 1];
            pts.push(x, H(x, z) + (k === 0 ? 1.3 : 1.0), z);
            if (k > 0) this.burst(x, H(x, z) + 1, z, 3, 5, 0.25, 0.4, 1.2, 1.7, 3.2, 0.6, 4, 3);
          }
          this.ribbons.add(pts, 0.22, 1.3, 1.9, 3.6, 0.2, 1);
          if (ev.pts.length >= 4) this.flashLight(ev.pts[2], H(ev.pts[2], ev.pts[3]) + 2, ev.pts[3], 0.6, 0.8, 1, 60, 0.18);
          break;
        }
        case 'beam': {
          const y0 = H(ev.x, ev.z) + 1.1;
          const ex = ev.x + ev.dx * ev.len, ez = ev.z + ev.dz * ev.len;
          this.ribbons.add([ev.x + ev.dx * 0.8, y0, ev.z + ev.dz * 0.8, ex, H(ex, ez) + 1.1, ez], ev.w * 0.9, 3.4, 2.9, 1.5, 0.3, 0);
          this.ribbons.add([ev.x + ev.dx * 0.8, y0, ev.z + ev.dz * 0.8, ex, H(ex, ez) + 1.1, ez], ev.w * 0.3, 4, 4, 3.4, 0.36, 0);
          for (let t = 1; t < ev.len; t += 1.1) {
            const x = ev.x + ev.dx * t, z = ev.z + ev.dz * t;
            this.sparks.spawn(x, H(x, z) + 1.1, z, (Math.random() - 0.5) * 3, Math.random() * 3, (Math.random() - 0.5) * 3, 0.5, 0.5, 2.6, 2.2, 1.0, { drag: 2 });
          }
          this.rings.push({ x: ev.x + ev.dx * ev.len * 0.5, z: ev.z + ev.dz * ev.len * 0.5, r0: ev.len * 0.5, r1: ev.w * 1.6, t: 0, dur: 0.4, r: ev.dx, g: ev.dz, b: 0, type: DECAL.beam });
          this.addShake(0.08);
          break;
        }
        case 'nova': {
          const col = new THREE.Color(ev.c);
          this.ring(ev.x, ev.z, 0.5, ev.r, 0.34, col.r * 1.8, col.g * 1.8, col.b * 1.8);
          this.ring(ev.x, ev.z, 0.2, ev.r * 0.92, 0.42, col.r * 0.9, col.g * 0.9, col.b * 0.9, DECAL.glow);
          const y = H(ev.x, ev.z) + 0.5;
          const n = Math.min(46, Math.round(ev.r * 4.5));
          for (let k = 0; k < n; k++) {
            const a = (k / n) * TAU + Math.random() * 0.2;
            const s = ev.r / 0.36;
            this.sparks.spawn(ev.x + Math.cos(a) * 0.5, y, ev.z + Math.sin(a) * 0.5, Math.cos(a) * s, 1 + Math.random() * 2, Math.sin(a) * s, 0.36, 0.65, col.r * 2.6, col.g * 2.6, col.b * 2.6, { drag: 1.2 });
          }
          this.flashLight(ev.x, y + 2, ev.z, col.r, col.g, col.b, 70, 0.3);
          this.addShake(0.06);
          break;
        }
        case 'shoot': {
          if (ev.w === 'ember' || ev.w === 'frost' || ev.w === 'glaive') {
            const c = WCOL[ev.w];
            const ax = Math.cos(p.aim), az = Math.sin(p.aim);
            const y = H(ev.x, ev.z) + 1.1;
            for (let k = 0; k < 4; k++) this.sparks.spawn(ev.x + ax * 0.8, y, ev.z + az * 0.8, ax * (4 + Math.random() * 6) + (Math.random() - 0.5) * 3, Math.random() * 2, az * (4 + Math.random() * 6) + (Math.random() - 0.5) * 3, 0.2, 0.45, c[0] * 2.5, c[1] * 2.5, c[2] * 2.5, { drag: 4 });
          }
          break;
        }
        case 'pickup': {
          const y = H(p.x, p.z) + 1;
          if (ev.kind === 'xp') {
            if (this.fxBudget < 6) {
              this.fxBudget++;
              this.burst(p.x, y, p.z, 2, 3, 0.3, 0.35, 0.6, 1.4, 2.4, 1, 0, 3);
            }
          } else if (ev.kind === 'cinder') this.burst(p.x, y, p.z, 8, 4, 0.5, 0.45, 3, 1.6, 0.4, 1.2, 4, 2);
          else if (ev.kind === 'magnet') {
            this.ring(p.x, p.z, 1, 30, 0.6, 0.5, 0.9, 2);
            this.burst(p.x, y, p.z, 24, 9, 0.6, 0.5, 0.6, 1.4, 3, 0.6, 2, 2);
          } else if (ev.kind === 'chest') {
            this.burst(p.x, y, p.z, 40, 9, 0.9, 0.6, 3, 2.2, 0.6, 1.4, 6, 1.5);
            this.ring(p.x, p.z, 0.5, 7, 0.5, 2, 1.5, 0.4);
          }
          break;
        }
        case 'levelup': {
          const y = H(p.x, p.z);
          this.ring(p.x, p.z, 0.5, 9, 0.6, 1.2, 1.9, 2.6);
          this.ring(p.x, p.z, 0.5, 5, 0.8, 0.5, 0.9, 1.4, DECAL.glow);
          for (let k = 0; k < 50; k++) {
            const a = Math.random() * TAU, d = Math.random() * 1.6;
            this.sparks.spawn(p.x + Math.cos(a) * d, y + Math.random() * 0.5, p.z + Math.sin(a) * d, 0, 4 + Math.random() * 9, 0, 0.9, 0.5, 1.0, 2.0, 3.0, { drag: 1.5 });
          }
          this.flashLight(p.x, y + 2, p.z, 0.6, 0.85, 1, 100, 0.5);
          this.overlay.text(p.x, y + 2.2, p.z, 'LEVEL UP', '#9fe0ff', 22, 1.1);
          break;
        }
        case 'hurt': {
          this.hurt = 1;
          this.addShake(0.45);
          this.aberr = 0.012;
          const y = H(p.x, p.z) + 1;
          this.burst(p.x, y, p.z, 14, 7, 0.4, 0.5, 3, 0.4, 0.3, 0.6, 8, 2);
          this.overlay.text(p.x, y + 1, p.z, '-' + ev.dmg, '#ff5a5a', 20, 0.8);
          this.hitStop = Math.max(this.hitStop, 0.045);
          break;
        }
        case 'heal': {
          const y = H(p.x, p.z) + 1;
          for (let k = 0; k < 12; k++) this.sparks.spawn(p.x + (Math.random() - 0.5) * 1.2, y - 0.5 + Math.random(), p.z + (Math.random() - 0.5) * 1.2, 0, 2 + Math.random() * 2, 0, 0.8, 0.45, 0.6, 3, 1.0, { drag: 1 });
          if (ev.v >= 3) this.overlay.text(p.x, y + 1, p.z, '+' + Math.round(ev.v), '#7dff9b', 17, 0.9);
          break;
        }
        case 'dash': {
          const y = H(ev.x, ev.z);
          this.puff(ev.x, y + 0.2, ev.z, 6, 1.4, 0.3);
          const a = this.player?.accent;
          if (a) this.burst(ev.x, y + 0.8, ev.z, 10, 4, 0.4, 0.5, a.r * 2.5, a.g * 2.5, a.b * 2.5, 0.4, 0, 3);
          break;
        }
        case 'beaconLit': {
          const y = H(ev.x, ev.z);
          this.ring(ev.x, ev.z, 1, 18, 0.7, 3, 1.8, 0.6);
          this.ring(ev.x, ev.z, 1, 30, 1.2, 1.5, 0.8, 0.3);
          this.ring(ev.x, ev.z, 0, 16, 1.0, 1.4, 0.8, 0.3, DECAL.glow);
          for (let k = 0; k < 160; k++) {
            const a = Math.random() * TAU;
            const s = 4 + Math.random() * 16;
            this.sparks.spawn(ev.x, y + 4.5, ev.z, Math.cos(a) * s, 3 + Math.random() * 16, Math.sin(a) * s, 1.2 + Math.random(), 0.75, 3.2, 1.7 + Math.random(), 0.4, { grav: 5, drag: 1.1 });
          }
          this.flashLight(ev.x, y + 6, ev.z, 1, 0.7, 0.35, 420, 1.0);
          this.addShake(0.7);
          this.flash = Math.max(this.flash, 0.5);
          this.fovKick = 5;
          this.litT = 0;
          this.litX = ev.x;
          this.litZ = ev.z;
          this.hitStop = Math.max(this.hitStop, 0.12);
          break;
        }
        case 'skill': {
          const y = H(ev.x, ev.z);
          switch (ev.id) {
            case 'flare':
              this.ring(ev.x, ev.z, 0.5, ev.r, 0.4, 3, 1.5, 0.4);
              this.ring(ev.x, ev.z, 0.2, ev.r * 0.7, 0.55, 2.2, 0.9, 0.25);
              this.ring(ev.x, ev.z, 0, ev.r * 0.95, 0.7, 1.3, 0.6, 0.2, DECAL.glow);
              for (let k = 0; k < 90; k++) {
                const a = Math.random() * TAU, s = (0.4 + Math.random() * 0.6) * ev.r / 0.4;
                this.sparks.spawn(ev.x, y + 0.6, ev.z, Math.cos(a) * s, 1 + Math.random() * 5, Math.sin(a) * s, 0.45 + Math.random() * 0.3, 0.8, 3.2, 1.5 + Math.random(), 0.35, { drag: 1.4 });
              }
              this.flashLight(ev.x, y + 3, ev.z, 1, 0.6, 0.25, 260, 0.6);
              this.addShake(0.55);
              this.flash = Math.max(this.flash, 0.3);
              break;
            case 'tempest':
              this.ring(ev.x, ev.z, 1, ev.r, 0.5, 0.9, 1.4, 3);
              this.burst(ev.x, y + 1.5, ev.z, 40, 14, 0.5, 0.5, 1.4, 2.0, 3.2, 1, 2, 2);
              this.flashLight(ev.x, y + 5, ev.z, 0.6, 0.8, 1, 320, 0.5);
              this.addShake(0.6);
              this.flash = Math.max(this.flash, 0.4);
              this.aberr = Math.max(this.aberr, 0.014);
              break;
            case 'bulwark':
              this.ring(ev.x, ev.z, 0.5, ev.r, 0.38, 1.0, 2.6, 3);
              this.ring(ev.x, ev.z, 0.5, ev.r * 0.6, 0.6, 0.6, 1.6, 2);
              this.burst(ev.x, y + 1, ev.z, 36, 9, 0.6, 0.5, 0.8, 1.8, 2.2, 0.4, 0, 2.5);
              this.flashLight(ev.x, y + 3, ev.z, 0.5, 0.9, 1, 200, 0.5);
              this.addShake(0.5);
              break;
            case 'deepfreeze':
              this.ring(ev.x, ev.z, 0.5, ev.r, 0.55, 1.6, 2.6, 3.2);
              this.ring(ev.x, ev.z, 0, ev.r, 0.9, 0.5, 0.9, 1.2, DECAL.glow);
              for (let k = 0; k < 110; k++) {
                const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * ev.r;
                const x = ev.x + Math.cos(a) * d, z = ev.z + Math.sin(a) * d;
                this.sparks.spawn(x, H(x, z) + 0.2, z, 0, 1.5 + Math.random() * 3, 0, 0.7 + Math.random() * 0.5, 0.5, 1.4, 2.4, 3.2, { drag: 1, grav: -1 });
              }
              this.flashLight(ev.x, y + 4, ev.z, 0.6, 0.85, 1, 240, 0.7);
              this.addShake(0.4);
              this.flash = Math.max(this.flash, 0.3);
              break;
            case 'reflect':
              this.ring(ev.x, ev.z, 0.3, ev.r, 0.4, 1.4, 1.6, 2);
              this.burst(ev.x, y + 1, ev.z, 30, 6, 0.5, 0.45, 1.6, 1.8, 2.2, 0.8, 0, 2);
              break;
            case 'whirl':
              this.ring(ev.x, ev.z, 0.3, ev.r, 0.3, 0.9, 1.8, 2);
              break;
            case 'overclock':
              this.ring(ev.x, ev.z, 0.3, 5, 0.35, 2.2, 1.6, 0.5);
              this.burst(ev.x, y + 1, ev.z, 36, 7, 0.5, 0.45, 2.4, 1.8, 0.6, 1, 2, 2);
              this.fovKick = Math.max(this.fovKick, 2.5);
              break;
            case 'barrage':
              this.ring(ev.x, ev.z, 0.3, 4, 0.3, 2.4, 1.4, 0.4);
              break;
            case 'pyre':
              this.ring(ev.x, ev.z, 0.5, ev.r, 0.4, 3, 1.2, 0.3);
              this.burst(ev.x, y + 0.8, ev.z, 50, 7, 0.6, 0.55, 3, 1.2, 0.3, 0.8, 2, 2);
              this.flashLight(ev.x, y + 3, ev.z, 1, 0.5, 0.2, 200, 0.6);
              this.addShake(0.35);
              break;
            case 'blink':
              this.ring(ev.x, ev.z, 0.3, ev.r, 0.35, 1.4, 1.8, 3);
              this.burst(ev.x, y + 1, ev.z, 30, 9, 0.4, 0.45, 1.4, 1.9, 3, 0.6, 0, 2);
              this.flashLight(ev.x, y + 3, ev.z, 0.7, 0.85, 1, 180, 0.35);
              this.aberr = Math.max(this.aberr, 0.012);
              this.addShake(0.3);
              break;
            case 'sanctuary':
              this.ring(ev.x, ev.z, 0.5, ev.r, 0.6, 0.6, 1.5, 1.05);
              this.burst(ev.x, y + 1, ev.z, 40, 5, 1.0, 0.5, 1.2, 3, 2.2, 2, -1.5, 1);
              this.flashLight(ev.x, y + 4, ev.z, 0.6, 1, 0.8, 200, 0.7);
              break;
            case 'vortex':
              this.ring(ev.x, ev.z, 0.5, 6, 0.4, 0.6, 1, 1.4);
              this.addShake(0.25);
              break;
            case 'effigy':
              this.ring(ev.x, ev.z, 0.5, 6, 0.5, 3, 1.1, 0.3);
              this.burst(ev.x, y + 1, ev.z, 40, 6, 0.6, 0.5, 3, 1.2, 0.3, 1.2, 2, 2);
              break;
            case 'stasis':
              this.ring(ev.x, ev.z, 1, ev.r, 0.9, 0.8, 0.7, 1.3);
              this.ring(ev.x, ev.z, 0, ev.r, 1.2, 0.25, 0.22, 0.45, DECAL.glow);
              this.flash = Math.max(this.flash, 0.2);
              this.aberr = Math.max(this.aberr, 0.02);
              this.addShake(0.3);
              break;
            case 'starcall':
              this.ring(ev.x, ev.z, 1, ev.r, 0.7, 1.6, 1.3, 0.6);
              this.ring(ev.x, ev.z, 0, ev.r, 1.1, 0.8, 0.65, 0.3, DECAL.glow);
              this.burst(ev.x, y + 1.5, ev.z, 50, 6, 1.2, 0.5, 3, 2.5, 1.2, 2.4, -2, 1);
              this.flashLight(ev.x, y + 6, ev.z, 1, 0.9, 0.6, 220, 0.8);
              this.addShake(0.35);
              break;
            case 'cinderstep':
              this.ring(ev.x, ev.z, 0.3, 4, 0.3, 3, 1.1, 0.3);
              this.burst(ev.x, y + 0.6, ev.z, 30, 8, 0.5, 0.5, 3, 1.2, 0.3, 0.6, 2, 2);
              this.fovKick = Math.max(this.fovKick, 3);
              break;
          }
          break;
        }
        case 'shrine': {
          const y = H(ev.x, ev.z);
          this.ring(ev.x, ev.z, 0.5, 7, 0.6, 1.2, 0.7, 2);
          this.burst(ev.x, y + 2.2, ev.z, 50, 6, 0.9, 0.5, 1.6, 1.0, 3, 1.4, -1, 1.2);
          this.flashLight(ev.x, y + 3, ev.z, 0.8, 0.5, 1, 160, 0.6);
          break;
        }
        case 'beaconPulse': {
          this.ring(ev.x, ev.z, 1.5, ev.r, 0.6, 1.6, 0.9, 0.3);
          break;
        }
        case 'bossSpawn': {
          const y = H(ev.x, ev.z);
          const c = KIND_COLOR[ev.kind];
          this.ring(ev.x, ev.z, 0.5, 14, 0.9, c[0] * 2, c[1] * 2, c[2] * 2);
          this.puff(ev.x, y + 1, ev.z, 24, 5, 0.06);
          this.burst(ev.x, y + 2, ev.z, 60, 12, 1.0, 0.7, c[0] * 3, c[1] * 3, c[2] * 3, 1, 3, 1.5);
          this.addShake(ev.kind === 'eclipse' ? 0.9 : 0.5);
          break;
        }
        case 'bossDie': {
          const y = H(ev.x, ev.z);
          const c = KIND_COLOR[ev.kind];
          const big = ev.kind === 'eclipse';
          const n = big ? 5 : 2;
          for (let k = 0; k < n; k++) this.ring(ev.x, ev.z, 1, 14 + k * 11, 0.7 + k * 0.3, c[0] * 2.5, c[1] * 2.5, c[2] * 2.5);
          this.burst(ev.x, y + 3, ev.z, big ? 320 : 120, big ? 26 : 16, 1.6, 0.9, c[0] * 3, c[1] * 3, c[2] * 3, 1, 6, 1);
          this.burst(ev.x, y + 3, ev.z, big ? 160 : 40, 12, 2.2, 0.7, 3, 2.6, 1.6, 1.4, 2, 0.8);
          this.puff(ev.x, y + 2, ev.z, 30, 6, 0.08);
          this.flashLight(ev.x, y + 5, ev.z, 1, 0.8, 0.6, 600, 1.4);
          this.addShake(1);
          this.flash = big ? 1.2 : 0.5;
          this.hitStop = Math.max(this.hitStop, big ? 0.5 : 0.15);
          break;
        }
        case 'loop': {
          this.flash = Math.max(this.flash, 0.6);
          this.addShake(0.7);
          this.aberr = 0.02;
          break;
        }
        case 'bossPhase': {
          this.addShake(0.8);
          this.flash = Math.max(this.flash, 0.35);
          this.aberr = 0.02;
          break;
        }
        case 'revive': {
          const y = H(ev.x, ev.z);
          this.burst(ev.x, y + 1, ev.z, 120, 14, 1.2, 0.8, 3, 2.2, 0.8, 1.5, 3, 1.2);
          this.flash = 0.8;
          this.addShake(0.6);
          break;
        }
        case 'death': {
          const y = H(ev.x, ev.z);
          this.burst(ev.x, y + 1, ev.z, 80, 9, 1.5, 0.7, 3, 1.2, 0.4, 1.2, 2, 1);
          this.addShake(0.8);
          this.hitStop = 0.6;
          break;
        }
        case 'freeze': {
          this.burst(ev.x, H(ev.x, ev.z) + 1, ev.z, 8, 4, 0.5, 0.45, 1.2, 2.2, 3, 0.8, 4, 2);
          break;
        }
        case 'spit': {
          this.burst(ev.x, H(ev.x, ev.z) + 1.3, ev.z, 5, 3, 0.3, 0.45, 1.4, 2.6, 0.6, 0.5, 2, 3);
          break;
        }
        case 'charge': {
          this.puff(ev.x, H(ev.x, ev.z) + 0.3, ev.z, 6, 1.6, 0.2);
          break;
        }
        case 'spawnElite': {
          this.ring(ev.x, ev.z, 0.5, 6, 0.8, 2.4, 1.6, 0.4);
          break;
        }
        default:
          break;
      }
    }
  }

  // ------------------------------------------------------------------ frame
  frame(dt: number, realDt: number) {
    this.time += realDt;
    this.modeT += realDt;
    shared.uTime.value = this.time;
    this.fxBudget = 0;
    if (!this.world || !this.env) return;
    const sim = this.sim;
    const H = this.height;
    const time = this.time;

    // ---- actors
    if (sim && this.player && this.enemies) {
      const p = sim.player;
      this.player.update(p, dt, time, H(p.x, p.z));
      this.enemies.update([sim.enemies, sim.bigs], H, p.x, p.z, time);
      // lantern embers + dash trail
      if (p.alive && Math.random() < dt * 30) {
        const lp = this.player.lanternPos, a = this.player.accent;
        this.sparks.spawn(lp.x, lp.y, lp.z, (Math.random() - 0.5) * 0.6, 0.8 + Math.random() * 1.2, (Math.random() - 0.5) * 0.6, 0.9, 0.3, a.r * 2.6, a.g * 2.6, a.b * 2.6, { drag: 0.6 });
      }
      if (p.dashT > 0) {
        const a = this.player.accent;
        for (let k = 0; k < 3; k++) this.sparks.spawn(p.x + (Math.random() - 0.5) * 0.6, H(p.x, p.z) + 0.3 + Math.random() * 1.2, p.z + (Math.random() - 0.5) * 0.6, 0, 0.5, 0, 0.35, 0.7, a.r * 2, a.g * 2, a.b * 2, { size1: 0.1 });
      }
      // burrowing enemies show only as a travelling plume of dust
      for (const e of this.enemies.buried) {
        const gy = H(e.x, e.z);
        if (Math.random() < dt * 40) this.smoke.spawn(e.x + (Math.random() - 0.5) * 0.8, gy + 0.1, e.z + (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 1.5, 1 + Math.random() * 1.5, (Math.random() - 0.5) * 1.5, 0.5, 0.9, 0.32, 0.2, 0.14, { drag: 2, size1: 1.6 });
        if (Math.random() < dt * 18) this.sparks.spawn(e.x, gy + 0.2, e.z, (Math.random() - 0.5) * 2, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 2, 0.4, 0.35, 2.4, 0.9, 0.2, { grav: 6 });
      }
      this.syncSim(sim, dt);
    } else if (this.player && this.enemies) {
      const hx = 2.4, hz = 1.8;
      this.player.idle(time, hx, H(hx, hz), hz, Math.atan2(hz, -hx) + Math.PI);
      this.enemies.update([], H, 0, 0, time);
      this.syncIdle();
    }
    this.updateSites(sim, dt);
    this.ambient(dt);

    // ---- transient rings → decals (decals.begin was called in syncSim / syncIdle)
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      if (r.t >= r.dur) {
        this.rings.splice(i, 1);
        continue;
      }
      const k = r.t / r.dur;
      const e = 1 - (1 - k) * (1 - k);
      if (r.type === DECAL.beam) {
        this.decals.addRect(DECAL.beam, r.x, r.z, r.r, r.g, r.r0, r.r1 * (1 - k * 0.5), 2.2, 1.8, 0.8, (1 - k) * 1.2);
      } else {
        const rad = lerp(r.r0, r.r1, e);
        this.decals.add(r.type, r.x, r.z, rad, r.r, r.g, r.b, (1 - k) * (r.type === DECAL.glow ? 0.9 : 1.4));
      }
    }
    this.decals.end();

    // ---- particles, ribbons, lights
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.ribbons.update(dt, this.camera.position);
    for (const f of this.flashes) {
      if (f.t < f.dur) {
        f.t += dt;
        const k = clamp(1 - f.t / f.dur, 0, 1);
        f.light.intensity = f.peak * k * k;
      } else f.light.intensity = 0;
    }

    // ---- camera
    this.updateCamera(dt, realDt);

    // ---- see-through hole so canopies never hide the player
    const cut = shared.uCut.value;
    if (sim && this.mode === 'follow') {
      const p = sim.player;
      this.v3.set(p.x, this.height(p.x, p.z) + 1.0, p.z).project(this.camera);
      const pr = this.renderer.getPixelRatio();
      const bw = this.w * pr, bh = this.h * pr;
      cut.set((this.v3.x * 0.5 + 0.5) * bw, (this.v3.y * 0.5 + 0.5) * bh, bh * 0.2, this.v3.z * 0.5 + 0.5 - 0.00002);
    } else cut.z = 0;

    // ---- environment / post
    let dawnTarget = 0;
    if (sim) {
      let litN = 0;
      for (const b of sim.beacons) if (b.lit) litN++;
      dawnTarget = Math.min(0.3, litN * 0.055);
      if (sim.stats.bossKilled) dawnTarget = 1;
    } else dawnTarget = 0.06;
    this.dawn = damp(this.dawn, dawnTarget, sim?.stats.bossKilled ? 0.55 : 0.8, realDt);
    this.env.apply(this.dawn, this.camTarget);
    this.hurt = Math.max(0, this.hurt - realDt * 2.4);
    this.flash = Math.max(0, this.flash - realDt * 1.8);
    this.aberr = damp(this.aberr, 0, 6, realDt);
    this.fovKick = damp(this.fovKick, 0, 3, realDt);
    const u = this.final.uniforms;
    u.uHurt.value = this.hurt * 0.5;
    u.uFlash.value = this.flash * 0.35 * this.flashMul;
    u.uAberr.value = this.aberr * this.flashMul;
    u.uTime.value = time;
    let low = 0;
    let bossMood = 0;
    if (sim) {
      const f = sim.player.hp / sim.player.st.maxHp;
      low = sim.player.alive ? clamp((0.35 - f) / 0.35, 0, 1) : 1;
      if (sim.boss) bossMood = 1;
    }
    u.uLowHp.value = damp(u.uLowHp.value, low, 4, realDt);
    const tint = u.uTint.value as THREE.Vector3;
    tint.x = damp(tint.x, 1 + bossMood * 0.12, 1.5, realDt);
    tint.y = damp(tint.y, 1 - bossMood * 0.1, 1.5, realDt);
    tint.z = damp(tint.z, 1 - bossMood * 0.06, 1.5, realDt);
    this.bloom.strength = 0.55 - this.dawn * 0.25;

    this.composer.render(realDt);
    this.drawOverlay(realDt);
  }

  private syncIdle() {
    this.decals.begin();
    for (const i of [this.iEmber, this.iFrost, this.iDart, this.iGlaive, this.iBullet, this.iWisp, this.iMeteor, this.iGem, this.iHeart, this.iMagnet, this.iCoin, this.iChest]) {
      i.begin();
      i.end();
    }
    this.bossHalo.visible = false;
    this.bossRing.visible = false;
  }

  /** push simulation state into instanced meshes and decals */
  private syncSim(sim: Sim, dt: number) {
    const H = this.height;
    const time = this.time;
    const p = sim.player;
    const dec = this.decals;
    dec.begin();
    const R2 = 70 * 70;

    // --- player projectiles
    this.iEmber.begin(); this.iFrost.begin(); this.iDart.begin(); this.iGlaive.begin();
    for (let i = 0; i < sim.projs.length; i++) {
      const pr = sim.projs[i];
      if (!pr.alive) continue;
      const y = H(pr.x, pr.z) + 1.0;
      const yaw = -Math.atan2(pr.vz, pr.vx);
      switch (pr.kind) {
        case 'ember': {
          const s = pr.r * 2.3 * (pr.evolved ? 1.3 : 1);
          this.iEmber.add(pr.x, y, pr.z, yaw, s, s, s, 3.4, pr.evolved ? 2.0 : 1.25, 0.3);
          if (Math.random() < dt * 40) this.sparks.spawn(pr.x, y, pr.z, (Math.random() - 0.5) * 2, Math.random() * 1.5, (Math.random() - 0.5) * 2, 0.3, 0.42, 3, 1.2, 0.25, { drag: 2 });
          break;
        }
        case 'frost': {
          const s = pr.r * 2.2;
          this.iFrost.add(pr.x, y, pr.z, yaw, s, s, s, 0.45, 1.2, 2.1);
          if (Math.random() < dt * 14) this.sparks.spawn(pr.x, y, pr.z, 0, 0.4, 0, 0.35, 0.3, 0.8, 1.8, 3, { drag: 1 });
          break;
        }
        case 'dart': {
          const s = pr.r * 2.2;
          this.iDart.add(pr.x, y + 0.3, pr.z, yaw, s, s, s, 2.0, 1.0, 3.4);
          if (Math.random() < dt * 60) this.sparks.spawn(pr.x, y + 0.3, pr.z, 0, 0, 0, 0.3, 0.42, 1.5, 0.7, 2.8, { size1: 0.05 });
          break;
        }
        case 'glaive': {
          const s = pr.r * 1.05;
          this.iGlaive.add(pr.x, y, pr.z, time * 22, s, s * 1.4, s, 1.8, 2.1, 3.0);
          if (Math.random() < dt * 40) {
            const a = Math.random() * TAU;
            this.sparks.spawn(pr.x + Math.cos(a) * pr.r, y, pr.z + Math.sin(a) * pr.r, 0, 0.5, 0, 0.25, 0.4, 1.4, 1.7, 3, {});
          }
          break;
        }
      }
    }
    this.iEmber.end(); this.iFrost.end(); this.iDart.end(); this.iGlaive.end();

    // --- lingering signature effects
    if (p.alive && p.skillT > 0) {
      if (sim.skill === 'bulwark') {
        const pulse = 0.75 + Math.sin(time * 14) * 0.15;
        dec.add(DECAL.ring, p.x, p.z, 2.1, 0.4 * pulse, 1.2 * pulse, 1.6 * pulse, Math.min(1, p.skillT * 2));
        dec.add(DECAL.glow, p.x, p.z, 2.6, 0.3, 0.8, 1.0, 0.22 * Math.min(1, p.skillT * 2));
      } else if (sim.skill === 'pyre') {
        const R = 5.5 * p.st.area, f = Math.min(1, p.skillT * 2);
        dec.add(DECAL.ring, p.x, p.z, R, 1.0, 0.4, 0.1, 0.7 * f);
        dec.add(DECAL.glow, p.x, p.z, R, 0.9, 0.35, 0.08, 0.35 * f);
        for (let k = 0; k < 3; k++) if (Math.random() < dt * 40) {
          const a = Math.random() * TAU, x = p.x + Math.cos(a) * R * 0.95, z = p.z + Math.sin(a) * R * 0.95;
          this.sparks.spawn(x, H(x, z) + 0.2, z, 0, 2 + Math.random() * 2.5, 0, 0.5, 0.55, 3, 1.2, 0.3, { drag: 1 });
        }
      } else if (sim.skill === 'sanctuary') {
        const R = 6.5 * p.st.area, f = Math.min(1, p.skillT * 1.5);
        const pulse = 0.8 + Math.sin(time * 3) * 0.2;
        dec.add(DECAL.ring, p.skillX, p.skillZ, R, 0.35 * pulse, 0.9 * pulse, 0.65 * pulse, f);
        dec.add(DECAL.glow, p.skillX, p.skillZ, R, 0.25, 0.7, 0.5, 0.3 * f);
        if (Math.random() < dt * 30) {
          const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * R, x = p.skillX + Math.cos(a) * d, z = p.skillZ + Math.sin(a) * d;
          this.sparks.spawn(x, H(x, z) + 0.1, z, 0, 1.2 + Math.random(), 0, 1.0, 0.4, 1.0, 2.6, 1.8, { drag: 0.6, grav: -0.3 });
        }
      } else if (sim.skill === 'vortex') {
        const R = 11 * p.st.area, k = 1 - p.skillT / 1.3;
        dec.add(DECAL.ring, p.skillX, p.skillZ, R * (1 - k * 0.6), 0.3, 0.6, 0.9, 0.7);
        dec.add(DECAL.glow, p.skillX, p.skillZ, 3 + k * 2, 0.2, 0.4, 0.6, 0.35);
        for (let q = 0; q < 2; q++) if (Math.random() < dt * 50) {
          const a = Math.random() * TAU, d = R * (0.4 + Math.random() * 0.6), x = p.skillX + Math.cos(a) * d, z = p.skillZ + Math.sin(a) * d;
          const tx = -Math.sin(a), tz = Math.cos(a);
          this.sparks.spawn(x, H(x, z) + 0.4, z, (tx * 6 - Math.cos(a) * 5), 0.5, (tz * 6 - Math.sin(a) * 5), 0.6, 0.4, 1.4, 2.4, 3.2, { drag: 0.3 });
        }
      } else if (sim.skill === 'effigy') {
        const y = H(p.skillX, p.skillZ);
        const f = Math.min(1, p.skillT * 2);
        dec.add(DECAL.glow, p.skillX, p.skillZ, 2.8, 1.0, 0.4, 0.1, 0.6 * f);
        dec.add(DECAL.ring, p.skillX, p.skillZ, 2.6, 2.0, 0.7, 0.2, 0.7 * f);
        for (let q = 0; q < 3; q++) if (Math.random() < dt * 60) {
          this.sparks.spawn(p.skillX + (Math.random() - 0.5) * 0.7, y + 0.3 + Math.random() * 1.8, p.skillZ + (Math.random() - 0.5) * 0.7, 0, 2.5 + Math.random() * 2, 0, 0.6, 0.7, 3, 1.3, 0.3, { drag: 1 });
        }
      } else if (sim.skill === 'reflect') {
        const R = 3.6 * p.st.area, f = Math.min(1, p.skillT * 2);
        dec.add(DECAL.ring, p.x, p.z, R, 0.6 * f, 0.7 * f, 0.9 * f, 0.8);
      } else if (sim.skill === 'whirl') {
        const R = 3.8 * p.st.area, a = time * 14;
        dec.add(DECAL.ring, p.x, p.z, R, 0.35, 0.8, 1.0, 0.7);
        for (let q = 0; q < 2; q++) {
          const aa = a + q * Math.PI, x = p.x + Math.cos(aa) * R * 0.85, z = p.z + Math.sin(aa) * R * 0.85;
          this.sparks.spawn(x, H(x, z) + 0.8, z, -Math.sin(aa) * 4, 0.5, Math.cos(aa) * 4, 0.25, 0.45, 1.2, 2.4, 2.8, { drag: 2 });
        }
      } else if (sim.skill === 'overclock' && Math.random() < dt * 40) {
        this.sparks.spawn(p.x + (Math.random() - 0.5), H(p.x, p.z) + 0.6 + Math.random(), p.z + (Math.random() - 0.5), 0, 1.5, 0, 0.35, 0.4, 2.6, 2.0, 0.6, { drag: 1 });
      } else if (sim.skill === 'cinderstep' && Math.random() < dt * 60) {
        this.sparks.spawn(p.x, H(p.x, p.z) + 0.4, p.z, (Math.random() - 0.5) * 2, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 2, 0.4, 0.5, 3, 1.3, 0.3, { drag: 1 });
      }
    }

    // --- enemy projectiles
    this.iBullet.begin();
    for (let i = 0; i < sim.eprojs.length; i++) {
      const b = sim.eprojs[i];
      if (!b.alive) continue;
      const y = H(b.x, b.z) + 1.0;
      const s = b.r * 2.3 * (1 + Math.sin(time * 18 + b.id) * 0.12);
      if (this.assist) {
        // one unmistakable colour for everything that hurts, slightly larger
        this.iBullet.add(b.x, y, b.z, 0, s * 1.2, s * 1.2, s * 1.2, 2.6, 0.5, 2.8);
        dec.add(DECAL.glow, b.x, b.z, 1.4, 1.0, 0.25, 1.0, 0.5);
      } else if (b.kind === 0) {
        this.iBullet.add(b.x, y, b.z, 0, s, s, s, 0.6, 1.7, 0.25);
        dec.add(DECAL.glow, b.x, b.z, 1.1, 0.3, 0.8, 0.1, 0.32);
      } else if (b.kind === 2) {
        this.iBullet.add(b.x, y, b.z, 0, s, s, s, 2.6, 0.85, 0.15);
        dec.add(DECAL.glow, b.x, b.z, 1.2, 0.9, 0.35, 0.08, 0.4);
        if (Math.random() < dt * 30) this.sparks.spawn(b.x, y, b.z, 0, 0.6, 0, 0.3, 0.4, 2.6, 0.9, 0.15, { size1: 0.05 });
      } else {
        this.iBullet.add(b.x, y, b.z, 0, s * 0.85, s * 0.85, s * 0.85, 1.5, 0.06, 0.5);
        dec.add(DECAL.glow, b.x, b.z, 1.1, 0.9, 0.08, 0.4, 0.32);
      }
    }
    this.iBullet.end();

    // --- weapons with persistent visuals
    this.iWisp.begin();
    for (const w of p.weapons) {
      if (!p.alive) break;
      const s = wstats(w);
      const evo = w.level >= EVOLVED_LEVEL;
      if (w.id === 'wisps') {
        const n = s.count + p.st.amount;
        const R = s.area * p.st.area;
        const size = 0.95 * Math.sqrt(p.st.area) * (evo ? 1.25 : 1);
        for (let i = 0; i < n; i++) {
          const a = w.a + (i / n) * TAU;
          const x = p.x + Math.cos(a) * R, z = p.z + Math.sin(a) * R;
          const y = H(x, z) + 1.0 + Math.sin(time * 3 + i) * 0.12;
          if (evo) this.iWisp.add(x, y, z, 0, size, size, size, 2.2, 1.2, 0.3);
          else this.iWisp.add(x, y, z, 0, size, size, size, 0.3, 1.15, 1.8);
          if (Math.random() < dt * 34) this.sparks.spawn(x, y, z, 0, 0.3, 0, 0.32, 0.6, evo ? 3 : 0.5, evo ? 1.6 : 1.8, evo ? 0.4 : 2.8, { size1: 0.05 });
          dec.add(DECAL.glow, x, z, 1.5, evo ? 0.8 : 0.15, evo ? 0.45 : 0.5, evo ? 0.1 : 0.75, 0.5);
        }
      } else if (w.id === 'sprite') {
        for (let i = 0; i < sim.sprites.length; i++) {
          const sp = sim.sprites[i];
          const y = H(sp.x, sp.z) + 1.25 + Math.sin(time * 4 + i * 1.7) * 0.15;
          const size = (sp.st === 1 ? 0.55 : 0.42) * (evo ? 1.15 : 1);
          if (evo) this.iWisp.add(sp.x, y, sp.z, time * 3, size, size * 1.3, size, 0.3, 1.15, 0.95);
          else this.iWisp.add(sp.x, y, sp.z, time * 3, size, size * 1.3, size, 1.3, 0.95, 0.3);
          if (Math.random() < dt * (sp.st === 1 ? 90 : 20)) this.sparks.spawn(sp.x, y, sp.z, 0, 0.2, 0, 0.3, 0.45, evo ? 0.8 : 2.6, 2.0, evo ? 1.8 : 0.8, { size1: 0.04 });
          dec.add(DECAL.glow, sp.x, sp.z, 1.1, evo ? 0.2 : 0.7, 0.55, evo ? 0.5 : 0.2, 0.4);
        }
      } else if (w.id === 'aura') {
        const R = s.area * p.st.area;
        dec.add(DECAL.aura, p.x, p.z, R, 1.0, 0.75, 0.35, evo ? 0.5 : 0.3);
      }
    }
    this.iWisp.end();
    // pickup-range hint + lantern pool of light on the ground
    dec.add(DECAL.glow, p.x, p.z, 4.2, 0.5, 0.28, 0.1, 0.5);

    // --- zones
    this.iMeteor.begin();
    for (let i = 0; i < sim.zones.length; i++) {
      const z = sim.zones[i];
      if (!z.alive) continue;
      const k = clamp(z.t / z.dur, 0, 1);
      switch (z.kind) {
        case 'fire':
        case 'crater': {
          const fade = Math.min(1, z.t * 5) * Math.min(1, (z.dur - z.t) * 2.5);
          dec.add(DECAL.fire, z.x, z.z, z.r * 1.08, z.kind === 'fire' ? 1.0 : 0.9, z.kind === 'fire' ? 0.38 : 0.2, 0.08, fade * 1.1, 0, (z.id % 97) / 97);
          if (Math.random() < dt * z.r * z.r * 5) {
            const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * z.r * 0.9;
            const x = z.x + Math.cos(a) * d, zz = z.z + Math.sin(a) * d;
            this.sparks.spawn(x, H(x, zz) + 0.15, zz, 0, 1.4 + Math.random() * 2.4, 0, 0.5 + Math.random() * 0.4, 0.7, 3, 0.9 + Math.random() * 0.8, 0.15, { size1: 0.1, drag: 0.5 });
          }
          break;
        }
        case 'meteor': {
          dec.add(DECAL.target, z.x, z.z, z.r, 1.0, 0.8, 0.3, 0.9, k);
          const hgt = (1 - k) * (1 - k) * 34;
          const mx = z.x + hgt * 0.25, mz = z.z - hgt * 0.18;
          const y = H(z.x, z.z) + 0.8 + hgt;
          this.iMeteor.add(mx, y, mz, time * 5, 1.5, 1.5, 1.5, 3.6, 2.4, 0.8);
          for (let q = 0; q < 2; q++) this.sparks.spawn(mx, y, mz, (Math.random() - 0.5) * 2, 2 + Math.random() * 3, (Math.random() - 0.5) * 2, 0.4, 0.85, 3.2, 1.8, 0.4, { size1: 0.1 });
          break;
        }
        case 'totem': {
          // a small stone post with a flame on top; flickers out in its last second
          const y = H(z.x, z.z);
          const life = Math.min(1, (z.dur - z.t) * 1.2) * Math.min(1, z.t * 5);
          dec.add(DECAL.ring, z.x, z.z, 0.9, 1.2 * life, 0.7 * life, 0.3 * life, 0.8);
          dec.add(DECAL.glow, z.x, z.z, 2.2, 0.8, 0.45, 0.15, 0.35 * life);
          this.iMeteor.add(z.x, y + 0.7, z.z, 0, 0.32, 0.9 * Math.max(0.2, life), 0.32, 0.5, 0.42, 0.38);
          const fy = y + 1.5 + Math.sin(time * 9 + z.id) * 0.05;
          this.iMeteor.add(z.x, fy, z.z, time * 3, 0.28 * life, 0.28 * life, 0.28 * life, z.evolved ? 3.2 : 2.6, z.evolved ? 2.2 : 1.4, 0.4);
          if (Math.random() < dt * 14 * life) this.sparks.spawn(z.x, fy + 0.1, z.z, 0, 1.2 + Math.random(), 0, 0.5, 0.3, 3, 1.4, 0.4, { drag: 0.8 });
          break;
        }
        case 'spore': {
          if (z.len > 0) {
            const fade = Math.min(1, z.len * 1.5) * (0.8 + Math.sin(time * 3 + z.id) * 0.2);
            if (this.assist) dec.add(DECAL.ring, z.x, z.z, z.r, 1.0, 0.3, 1.0, fade);
            else dec.add(DECAL.ring, z.x, z.z, z.r, 0.5, 1.4, 0.4, fade * 0.8);
            dec.add(DECAL.glow, z.x, z.z, z.r * 1.05, this.assist ? 0.7 : 0.25, this.assist ? 0.2 : 0.75, this.assist ? 0.7 : 0.2, 0.55 * fade);
            if (Math.random() < dt * 26) {
              const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * z.r;
              const x = z.x + Math.cos(a) * d, zz = z.z + Math.sin(a) * d;
              this.sparks.spawn(x, H(x, zz) + 0.2 + Math.random(), zz, (Math.random() - 0.5) * 0.6, 0.3 + Math.random() * 0.7, (Math.random() - 0.5) * 0.6, 1.2, 0.5, 0.9, 2.2, 0.6, { drag: 0.8, grav: -0.2 });
            }
            break;
          }
          if (this.assist) dec.add(DECAL.telegraph, z.x, z.z, z.r, 1.0, 0.3, 1.0, 1.0, k);
          else dec.add(DECAL.telegraph, z.x, z.z, z.r, 0.45, 1.0, 0.3, 1.0, k);
          break;
        }
        case 'sigil': {
          if (z.len > 0) {
            // echo charging: the rune turns gold and tightens
            const e = 1 - z.len / 0.45;
            dec.add(DECAL.target, z.x, z.z, z.r * (1.15 - e * 0.4), 2.4, 1.7, 0.5, 1.0, e);
            dec.add(DECAL.glow, z.x, z.z, z.r, 1.0, 0.7, 0.2, 0.5);
            break;
          }
          const armed = z.t > 0.45;
          const fade = Math.min(1, (z.dur - z.t) * 2) * Math.min(1, z.t * 4);
          const pulse = armed ? 0.75 + Math.sin(time * 5 + z.id) * 0.25 : 0.35;
          dec.add(DECAL.target, z.x, z.z, z.r * 0.42, 1.5 * pulse, 1.0 * pulse, 2.4 * pulse, fade, (time * 0.15 + z.id * 0.37) % 1);
          dec.add(DECAL.glow, z.x, z.z, z.r * 0.55, 0.5, 0.3, 0.9, 0.35 * fade * pulse);
          if (armed && Math.random() < dt * 5) this.sparks.spawn(z.x + (Math.random() - 0.5) * 0.8, H(z.x, z.z) + 0.1, z.z + (Math.random() - 0.5) * 0.8, 0, 1 + Math.random() * 1.5, 0, 0.6, 0.35, 1.8, 1.2, 3.0, { drag: 0.5, grav: -0.5 });
          break;
        }
        case 'slam': {
          if (this.assist) dec.add(DECAL.telegraph, z.x, z.z, z.r, 1.0, 0.3, 1.0, 1.0, k);
          else dec.add(DECAL.telegraph, z.x, z.z, z.r, 1.0, 0.16, 0.5, 1.0, k);
          break;
        }
        case 'vent': {
          if (this.assist) dec.add(DECAL.telegraph, z.x, z.z, z.r, 1.0, 0.3, 1.0, 1.0, k);
          else dec.add(DECAL.telegraph, z.x, z.z, z.r, 1.0, 0.42, 0.1, 1.0, k);
          if (Math.random() < dt * 30 * (0.3 + k)) {
            const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * z.r * 0.8;
            const x = z.x + Math.cos(a) * d, zz = z.z + Math.sin(a) * d;
            this.sparks.spawn(x, H(x, zz) + 0.1, zz, 0, 2 + Math.random() * 3 * k, 0, 0.5, 0.5, 2.6, 0.9, 0.15, { drag: 0.5 });
          }
          break;
        }
        case 'frost': {
          if (this.assist) dec.add(DECAL.telegraph, z.x, z.z, z.r, 1.0, 0.3, 1.0, 1.0, k);
          else dec.add(DECAL.telegraph, z.x, z.z, z.r, 0.35, 0.8, 1.0, 1.0, k);
          if (Math.random() < dt * 24 * (0.3 + k)) {
            const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * z.r * 0.8;
            const x = z.x + Math.cos(a) * d, zz = z.z + Math.sin(a) * d;
            this.sparks.spawn(x, H(x, zz) + 0.1, zz, 0, 1 + Math.random() * 2, 0, 0.6, 0.4, 0.8, 1.6, 2.6, { drag: 0.5 });
          }
          break;
        }
        case 'charge': {
          dec.addRect(DECAL.lane, z.x + z.dx * z.len * 0.5, z.z + z.dz * z.len * 0.5, z.dx, z.dz, z.len * 0.5, z.r, 1.0, 0.16, 0.3, 0.6 + k * 0.6);
          break;
        }
      }
    }
    this.iMeteor.end();

    // --- pickups
    this.iGem.begin(); this.iHeart.begin(); this.iMagnet.begin(); this.iCoin.begin(); this.iChest.begin();
    for (let i = 0; i < sim.pickups.length; i++) {
      const k = sim.pickups[i];
      if (!k.alive) continue;
      const dx = k.x - p.x, dz = k.z - p.z;
      if (dx * dx + dz * dz > R2) continue;
      const pop = Math.min(1, k.t * 5);
      const bob = Math.sin(time * 3 + k.id * 1.7) * 0.12;
      const y = H(k.x, k.z) + 0.55 + bob + (1 - pop) * 0.6;
      const yaw = time * 2 + k.id;
      switch (k.kind) {
        case 'xp': {
          if (k.v < 3) this.iGem.add(k.x, y, k.z, yaw, 0.85 * pop, 0.85 * pop, 0.85 * pop, 0.22, 0.6, 1.25);
          else if (k.v < 14) this.iGem.add(k.x, y, k.z, yaw, 1.15 * pop, 1.15 * pop, 1.15 * pop, 0.25, 1.2, 0.45);
          else this.iGem.add(k.x, y, k.z, yaw, 1.6 * pop, 1.6 * pop, 1.6 * pop, 1.5, 1.0, 0.2);
          break;
        }
        case 'heal':
          this.iHeart.add(k.x, y + 0.2, k.z, yaw, 1.3, 1.3, 1.3, 1.6, 0.3, 0.4);
          dec.add(DECAL.glow, k.x, k.z, 1.6, 0.8, 0.15, 0.2, 0.7);
          break;
        case 'magnet':
          this.iMagnet.add(k.x, y + 0.2, k.z, yaw, 1.4, 1.4, 1.4, 0.4, 0.8, 1.8);
          dec.add(DECAL.glow, k.x, k.z, 1.6, 0.15, 0.4, 0.9, 0.7);
          break;
        case 'cinder':
          this.iCoin.add(k.x, y, k.z, yaw * 1.5, 1, 1, 1, 1.7, 0.9, 0.25);
          break;
        case 'chest': {
          const s = 1.15 + Math.sin(time * 4) * 0.05;
          this.iChest.add(k.x, H(k.x, k.z) + (1 - pop) * 1.5, k.z, 0.6, s, s, s, 1, 1, 1);
          dec.add(DECAL.lit, k.x, k.z, 2.6, 1.0, 0.75, 0.25, 0.9);
          if (Math.random() < dt * 12) this.sparks.spawn(k.x + (Math.random() - 0.5), H(k.x, k.z) + 0.6, k.z + (Math.random() - 0.5), 0, 2 + Math.random() * 2, 0, 0.9, 0.4, 3, 2.2, 0.6, { drag: 0.5 });
          break;
        }
      }
    }
    this.iGem.end(); this.iHeart.end(); this.iMagnet.end(); this.iCoin.end(); this.iChest.end();

    // --- boss dressing
    const boss = sim.boss;
    if (boss && boss.alive) {
      const by = H(boss.x, boss.z) + 4.6 + Math.sin(time * 1.1) * 0.35;
      this.bossHalo.visible = true;
      this.bossHalo.position.set(boss.x, by, boss.z);
      this.bossHalo.quaternion.copy(this.camera.quaternion);
      const sc = (0.9 + boss.spawn * 0.25) * (1 + (boss.tele ? Math.sin(time * 24) * 0.04 : 0));
      this.bossHalo.scale.setScalar(sc);
      ((this.bossHalo.material as THREE.ShaderMaterial).uniforms.uPow.value as number) = 0.42 + boss.flash * 0.1 + (boss.phase - 1) * 0.14;
      this.bossRing.visible = true;
      this.bossRing.position.set(boss.x, by, boss.z);
      this.bossRing.rotation.set(Math.PI / 2 + Math.sin(time * 0.7) * 0.35, time * 0.9, 0);
      dec.add(DECAL.glow, boss.x, boss.z, 9, 0.9, 0.2, 0.1, 0.35);
      if (Math.random() < dt * 40) {
        const a = Math.random() * TAU;
        this.sparks.spawn(boss.x + Math.cos(a) * 3, by + (Math.random() - 0.5) * 3, boss.z + Math.sin(a) * 3, Math.cos(a) * 2, 1 + Math.random() * 2, Math.sin(a) * 2, 0.9, 0.6, 3, 0.8, 0.3, { drag: 0.6 });
      }
    } else {
      this.bossHalo.visible = false;
      this.bossRing.visible = false;
    }
  }

  /** beacons, hearth and the pooled site lights */
  private updateSites(sim: Sim | null, dt: number) {
    const world = this.world!;
    const dec = this.decals;
    const time = this.time;
    const cam = this.camTarget;
    interface Site { x: number; y: number; z: number; d: number; r: number; g: number; b: number; power: number }
    const sites: Site[] = [];
    // hearth fire at the origin
    const hy = this.height(0, 0);
    this.hearthFlame += dt;
    const hd = Math.hypot(cam.x, cam.z);
    if (hd < 90) {
      const n = Math.random() < dt * 46 ? 1 : 0;
      for (let k = 0; k < n + 1; k++) {
        const a = Math.random() * TAU, d = Math.random() * 0.45;
        this.sparks.spawn(Math.cos(a) * d, hy + 0.5 + Math.random() * 0.3, Math.sin(a) * d, (Math.random() - 0.5) * 0.5, 1.6 + Math.random() * 2.2, (Math.random() - 0.5) * 0.5, 0.5 + Math.random() * 0.5, 0.6, 1.5, 0.5 + Math.random() * 0.4, 0.08, { size1: 0.08, drag: 0.4 });
      }
      if (Math.random() < dt * 5) this.sparks.spawn(0, hy + 1.2, 0, (Math.random() - 0.5) * 1.5, 2.5 + Math.random() * 2, (Math.random() - 0.5) * 1.5, 1.6, 0.28, 3, 1.5, 0.4, { drag: 0.3 });
      dec.add(DECAL.glow, 0, 0, 7, 0.9, 0.45, 0.14, 0.35 + Math.sin(time * 9) * 0.03);
    }
    sites.push({ x: 0, y: hy + 1.6, z: 0, d: hd, r: 1, g: 0.6, b: 0.28, power: 36 + Math.sin(time * 11) * 3 });

    for (let i = 0; i < this.shrineDyn.length; i++) {
      const sd = this.shrineDyn[i];
      const ss = sim ? sim.shrines[i] : null;
      sd.fade = damp(sd.fade, ss && ss.used ? 0 : 1, 3, dt);
      const s = world.shrines[i];
      sd.crystal.visible = sd.fade > 0.02;
      sd.crystal.rotation.y = time * 1.2 + i;
      sd.crystal.position.y = sd.y + 2.2 + Math.sin(time * 2 + i) * 0.15;
      sd.crystal.scale.setScalar(0.6 * sd.fade);
      sd.beam.visible = sd.fade > 0.02;
      ((sd.beam.material as THREE.ShaderMaterial).uniforms.uPow.value as number) = (0.3 + Math.sin(time * 2.2 + i) * 0.06) * sd.fade;
      const d = Math.hypot(cam.x - s.x, cam.z - s.z);
      if (d < 70 && sd.fade > 0.05) {
        dec.add(DECAL.glow, s.x, s.z, 3.2, 0.6, 0.35, 1.0, 0.35 * sd.fade);
        dec.add(DECAL.ring, s.x, s.z, 2.4, 0.7, 0.45, 1.2, (0.4 + Math.sin(time * 3 + i) * 0.15) * sd.fade);
        if (Math.random() < dt * 8 * sd.fade) this.sparks.spawn(s.x + (Math.random() - 0.5), sd.y + 1.6, s.z + (Math.random() - 0.5), 0, 1 + Math.random(), 0, 1.2, 0.3, 1.6, 1.0, 2.6, { drag: 0.5, grav: -0.4 });
      }
    }

    for (let i = 0; i < world.beacons.length; i++) {
      const b = world.beacons[i];
      const dyn = this.beaconDyn[i];
      const st = sim ? sim.beacons[i] : null;
      const lit = st ? st.lit : false;
      const prog = st ? st.progress : 0;
      dyn.lit = damp(dyn.lit, lit ? 1 : 0, 2.5, dt);
      const d = Math.hypot(cam.x - b.x, cam.z - b.z);
      const mat = dyn.crystal.material as THREE.MeshBasicMaterial;
      const pulse = 1 + Math.sin(time * 2 + i) * 0.12;
      const L = dyn.lit;
      const pr = Math.max(prog, L);
      mat.color.setRGB(lerp(0.3, 2.6, pr) * pulse, lerp(0.6, 1.25, pr) * pulse, lerp(1.5, 0.3, pr) * pulse);
      dyn.crystal.position.y = dyn.y + 5.7 + Math.sin(time * 1.4 + i * 2) * 0.18 + prog * 0.5;
      dyn.crystal.rotation.y = time * (0.5 + pr * 2.5);
      const sc = 1 + pr * 0.5;
      dyn.crystal.scale.set(sc, sc, sc);
      dyn.pillar.visible = L > 0.01;
      if (dyn.pillar.visible) {
        (dyn.pillar.material as THREE.ShaderMaterial).uniforms.uPow.value = L * (0.21 + Math.sin(time * 3 + i) * 0.02) * (1 - this.dawn * 0.75);
        dyn.pillar.scale.set(1, L, 1);
      }
      if (d < 85) {
        if (!lit) {
          const near = clamp(1 - (d - 8) / 26, 0, 1);
          if (near > 0 || prog > 0) dec.add(DECAL.progress, b.x, b.z, 6.5, lerp(0.35, 1.0, prog), lerp(0.7, 0.75, prog), lerp(1.2, 0.3, prog), Math.max(near, prog > 0 ? 0.6 : 0) * (st?.channeling ? 1.5 : 0.8), prog);
          if (st?.channeling) {
            // embers spiral up the tower while channeling
            for (let k = 0; k < 2; k++) {
              const a = time * 3 + k * Math.PI + Math.random();
              const rr = 2.6 - prog * 1.5;
              this.sparks.spawn(b.x + Math.cos(a) * rr, dyn.y + 1 + Math.random() * 4, b.z + Math.sin(a) * rr, -Math.sin(a) * 3, 3 + prog * 4, Math.cos(a) * 3, 0.7, 0.55, lerp(0.6, 3.2, prog), lerp(1.4, 1.6, prog), lerp(3, 0.4, prog), { drag: 0.5 });
            }
          } else if (Math.random() < dt * 6) {
            this.sparks.spawn(b.x + (Math.random() - 0.5) * 2, dyn.y + 4.5 + Math.random(), b.z + (Math.random() - 0.5) * 2, 0, 0.6, 0, 1.4, 0.32, 0.5, 1.0, 2.6, {});
          }
        } else {
          dec.add(DECAL.lit, b.x, b.z, sim?.hasRelic('beaconbond') ? 14 : 8.5, 1.0, 0.6, 0.22, 0.42);
          dec.add(DECAL.glow, b.x, b.z, 11, 0.9, 0.45, 0.14, 0.4);
          const n = Math.random() < dt * 60 ? 2 : 1;
          for (let k = 0; k < n; k++) {
            const a = Math.random() * TAU, dd = Math.random() * 0.9;
            this.sparks.spawn(b.x + Math.cos(a) * dd, dyn.y + 4.4 + Math.random() * 0.4, b.z + Math.sin(a) * dd, (Math.random() - 0.5) * 0.8, 2.5 + Math.random() * 4, (Math.random() - 0.5) * 0.8, 0.6 + Math.random() * 0.6, 1.0, 1.7, 0.55 + Math.random() * 0.45, 0.1, { size1: 0.12, drag: 0.4 });
          }
        }
      }
      if (L > 0.02) sites.push({ x: b.x, y: dyn.y + 6, z: b.z, d, r: 1, g: 0.62, b: 0.3, power: 170 * L });
      else if (prog > 0.01 || d < 30) sites.push({ x: b.x, y: dyn.y + 6, z: b.z, d: d + 15, r: lerp(0.4, 1, prog), g: lerp(0.6, 0.7, prog), b: lerp(1, 0.4, prog), power: 22 + prog * 80 });
    }
    sites.sort((a, b) => a.d - b.d);
    for (let i = 0; i < this.siteLights.length; i++) {
      const l = this.siteLights[i];
      const s = sites[i];
      if (s && s.d < 110) {
        l.position.set(s.x, s.y, s.z);
        l.color.setRGB(s.r, s.g, s.b);
        l.intensity = s.power;
      } else l.intensity = 0;
    }
  }

  /** fireflies / snow / ash drifting through the air around the camera */
  private ambient(dt: number) {
    const biome = this.world!.biome.id;
    const c = new THREE.Color(this.pal.firefly);
    this.ambientT += dt * (biome === 'frostmere' ? 60 : 16);
    const tx = this.camTarget.x, tz = this.camTarget.z;
    while (this.ambientT >= 1) {
      this.ambientT -= 1;
      const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * 34;
      const x = tx + Math.cos(a) * d, z = tz + Math.sin(a) * d - 6;
      const y = this.height(x, z);
      if (y < SEA_LEVEL) continue;
      if (biome === 'frostmere') this.sparks.spawn(x, y + 9 + Math.random() * 6, z, 0.6, -2.2 - Math.random(), 0.3, 5, 0.22, 0.8, 0.9, 1.1, {});
      else if (biome === 'emberwaste') this.sparks.spawn(x, y + 0.2, z, 0.5, 0.8 + Math.random() * 1.2, 0.2, 4, 0.24, 2.2, 0.8, 0.2, {});
      else this.sparks.spawn(x, y + 0.6 + Math.random() * 2.2, z, (Math.random() - 0.5) * 0.7, (Math.random() - 0.3) * 0.3, (Math.random() - 0.5) * 0.7, 3 + Math.random() * 3, 0.26, c.r * 2.2, c.g * 2.2, c.b * 2.2, {});
    }
  }

  private updateCamera(dt: number, realDt: number) {
    const sim = this.sim;
    const cam = this.camera;
    const t = this.time;
    if (this.mode === 'menu' || !sim) {
      const a = t * 0.045 + 0.6;
      const R = 27;
      this.camTarget.set(0, this.height(0, 0) + 2.6, 0);
      this.camPos.set(Math.cos(a) * R, this.height(0, 0) + 7.5 + Math.sin(t * 0.11) * 1.2, Math.sin(a) * R);
      const gy = this.height(this.camPos.x, this.camPos.z) + 2.2;
      if (this.camPos.y < gy) this.camPos.y = gy;
      cam.position.copy(this.camPos);
      this.lookAt.set(0, this.height(0, 0) + 4.2, 0);
      if (cam.aspect > 1.25) {
        // shift the look target sideways (camera-left) so the fire sits in the right third
        const rx = -Math.sin(a), rz = Math.cos(a);
        this.lookAt.x += rx * 7.5;
        this.lookAt.z += rz * 7.5;
      }
      cam.lookAt(this.lookAt);
      return;
    }
    const p = sim.player;
    const py = this.height(p.x, p.z);
    // lead the camera slightly toward the aim so there is more view ahead
    const lead = 2.2;
    const tx = p.x + Math.cos(p.aim) * lead * 0.5 + p.vx * 0.12;
    const tz = p.z + Math.sin(p.aim) * lead * 0.5 + p.vz * 0.12;
    const k = 1 - Math.exp(-7 * realDt);
    // cinematic focus (boss introductions) pulls the view toward a point of interest
    const fw = this.focusW;
    let fx = tx + (this.focusX - tx) * fw, fz = tz + (this.focusZ - tz) * fw;
    // a freshly lit beacon gets a breath of attention: drift toward it and pull back to take in the light
    this.litT += realDt;
    const lt = this.litT;
    const lw = lt < 2.6 ? clamp(lt / 0.35, 0, 1) * (1 - clamp((lt - 1.3) / 1.3, 0, 1)) : 0;
    const lws = lw * lw * (3 - 2 * lw);
    if (lws > 0) {
      fx += (this.litX - fx) * lws * 0.45;
      fz += (this.litZ - fz) * lws * 0.45;
    }
    this.camTarget.x += (fx - this.camTarget.x) * k;
    this.camTarget.z += (fz - this.camTarget.z) * k;
    this.camTarget.y += (py - this.camTarget.y) * (1 - Math.exp(-4 * realDt));
    let dist = (35 * this.zoom + (sim.boss ? 5 : 0)) * (1 - fw * 0.3) * (1 + lws * 0.2);
    let pitch = 0.96; // radians above the horizon
    let lookY = 1.0;
    let yaw = 0;
    if (this.mode === 'victory') {
      const e = clamp(this.modeT / 5, 0, 1);
      const s = e * e * (3 - 2 * e);
      dist = lerp(dist, 26, s);
      pitch = lerp(pitch, 0.2, s);
      lookY = lerp(1, 7.5, s);
      // swing round to look at the sunrise (sun sits toward +x,+z)
      yaw = lerp(0, -2.25, s) + (this.modeT > 5 ? (this.modeT - 5) * 0.02 : 0);
    } else if (this.mode === 'death') {
      const e = clamp(this.modeT / 2.5, 0, 1);
      dist = lerp(dist, 17, e * e * (3 - 2 * e));
      pitch = lerp(pitch, 0.75, e);
      yaw = this.modeT * 0.08;
    }
    const cx = Math.sin(yaw) * Math.cos(pitch) * dist;
    const cz = Math.cos(yaw) * Math.cos(pitch) * dist;
    const want = this.v3.set(this.camTarget.x + cx, this.camTarget.y + Math.sin(pitch) * dist, this.camTarget.z + cz);
    const minY = this.height(want.x, want.z) + 2;
    if (want.y < minY) want.y = minY;
    this.camPos.lerp(want, this.mode === 'follow' ? 1 : 1 - Math.exp(-3 * realDt));
    cam.position.copy(this.camPos);
    // shake
    this.trauma = Math.max(0, this.trauma - realDt * 1.5);
    const sh = this.trauma * this.trauma * this.shakeMul;
    if (sh > 0.0005) {
      cam.position.x += (Math.sin(t * 61.3) + Math.sin(t * 37.1)) * 0.38 * sh;
      cam.position.y += (Math.sin(t * 53.7) + Math.sin(t * 29.9)) * 0.3 * sh;
      cam.position.z += (Math.sin(t * 47.9) + Math.sin(t * 41.3)) * 0.38 * sh;
    }
    this.lookAt.set(this.camTarget.x, this.camTarget.y + lookY, this.camTarget.z);
    cam.lookAt(this.lookAt);
    cam.rotation.z += (Math.sin(t * 43.1) * 0.012 + Math.sin(t * 71) * 0.008) * sh;
    const baseFov = cam.aspect < 1.2 ? lerp(58, 40, clamp((cam.aspect - 0.5) / 0.7, 0, 1)) : 40;
    const fov = baseFov + this.fovKick + (p.dashT > 0 ? 1.5 : 0);
    if (Math.abs(fov - cam.fov) > 0.01) {
      cam.fov = damp(cam.fov, fov, 10, realDt);
      cam.updateProjectionMatrix();
    }
    void dt;
  }

  /** 2D overlay: combat text, elite health bars, off-screen objective arrows */
  private drawOverlay(dt: number) {
    const ov = this.overlay;
    ov.clear();
    const sim = this.sim;
    if (!sim || this.mode === 'menu') return;
    const ctx = ov.ctx;
    const o = { x: 0, y: 0 };
    const cam = this.camera;
    // elite / mini-boss health bars
    if (this.enemies) {
      for (const e of this.enemies.marked) {
        if (e.kind === 'eclipse') continue;
        if (!ov.project(cam, e.x, this.height(e.x, e.z) + (e.kind === 'herald' ? 5.4 : 2.4 * e.scale + 0.4), e.z, o)) continue;
        const w = e.kind === 'herald' ? 90 : 46, h = 5;
        const f = clamp(e.hp / e.maxHp, 0, 1);
        ctx.fillStyle = 'rgba(8,6,16,0.75)';
        ctx.fillRect(o.x - w / 2 - 1, o.y - 1, w + 2, h + 2);
        const col = e.kind === 'herald' ? '#b86bff' : AFFIX_COLOR[e.affix] ?? '#ffc23a';
        ctx.fillStyle = col;
        ctx.fillRect(o.x - w / 2, o.y, w * f, h);
        if (e.affix > 0 && this.affixLabel) {
          ctx.font = '700 11px "Trebuchet MS", system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          const label = this.affixLabel(e.affix);
          ctx.fillStyle = 'rgba(8,6,16,0.85)';
          ctx.fillText(label, o.x + 1, o.y - 2);
          ctx.fillStyle = col;
          ctx.fillText(label, o.x, o.y - 3);
        }
      }
    }
    if (this.mode === 'follow') {
      // arrows toward unlit beacons / the boss / chests that are off-screen
      const p = sim.player;
      const m = 46;
      const arrow = (x: number, z: number, color: string, label: string, always: boolean) => {
        const vis = ov.project(cam, x, this.height(x, z) + 3, z, o);
        const on = vis && o.x > m && o.x < ov.w - m && o.y > m && o.y < ov.h - m;
        if (on && !always) return;
        if (on) return;
        // direction in screen space from the centre
        let dx = o.x - ov.w / 2, dy = o.y - ov.h / 2;
        if (!vis) {
          dx = -dx;
          dy = -dy;
        }
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
        const sx = (ov.w / 2 - m) / Math.max(0.001, Math.abs(dx));
        const sy = (ov.h / 2 - m) / Math.max(0.001, Math.abs(dy));
        const s = Math.min(sx, sy);
        const ax = ov.w / 2 + dx * s, ay = ov.h / 2 + dy * s;
        const pulse = 1 + Math.sin(this.time * 4) * 0.08;
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(Math.atan2(dy, dx));
        ctx.scale(pulse, pulse);
        ctx.beginPath();
        ctx.moveTo(15, 0);
        ctx.lineTo(-7, -10);
        ctx.lineTo(-2, 0);
        ctx.lineTo(-7, 10);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.restore();
        const dist = Math.round(Math.hypot(x - p.x, z - p.z));
        ctx.font = '700 12px "Trebuchet MS", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(8,6,16,0.8)';
        ctx.fillText(label + dist + 'm', ax - dx * 26 + 1, ay - dy * 26 + 1);
        ctx.fillStyle = color;
        ctx.fillText(label + dist + 'm', ax - dx * 26, ay - dy * 26);
      };
      for (const b of sim.beacons) if (!b.lit) arrow(b.x, b.z, b.progress > 0 ? '#ffc56b' : '#7fd4ff', '', false);
      if (sim.boss) arrow(sim.boss.x, sim.boss.z, '#ff5a3c', '', false);
      for (const g of sim.bigs) if (g.alive && g.kind === 'herald') arrow(g.x, g.z, '#b86bff', '', false);
      for (const k of sim.pickups) if (k.alive && k.kind === 'chest') arrow(k.x, k.z, '#ffd24a', '', false);
    }
    ov.drawTexts(cam, dt);
  }

  /** used by the weapon colour swatches in the UI */
  static weaponColor(id: WeaponId): string {
    return '#' + new THREE.Color(WEAPONS[id].color).getHexString();
  }
}
