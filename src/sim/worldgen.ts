import { Noise2D, RNG, clamp, smoothstep, lerp } from '../core/rng';

export type BiomeId = 'ashwood' | 'frostmere' | 'emberwaste' | 'gloommire';

export type ObstacleKind = 'pine' | 'oak' | 'dead' | 'rock' | 'pillar' | 'wall' | 'crystal' | 'stump' | 'shroom' | 'ice' | 'cactus' | 'bone';

export interface Obstacle {
  x: number;
  z: number;
  /** collision radius */
  r: number;
  kind: ObstacleKind;
  /** visual scale */
  s: number;
  rot: number;
  variant: number;
}

export interface Decor {
  x: number;
  z: number;
  kind: number; // 0 grass tuft, 1 flower (glow), 2 small shroom (glow), 3 pebble, 4 fern
  s: number;
  rot: number;
  tint: number;
}

export interface BeaconSite {
  x: number;
  z: number;
}

export interface PathSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export interface BiomeDef {
  id: BiomeId;
  /** obstacle kinds for trees, weights */
  trees: [ObstacleKind, number][];
  props: [ObstacleKind, number][];
  treeDensity: number;
  hill: number;
  /** multipliers applied to every enemy spawned in this region */
  enemyHp: number;
  enemySpeed: number;
  /** spawn weight multipliers by enemy kind (missing = 1) */
  weights: Record<string, number>;
  /** environmental hazard that erupts near the player */
  hazard: 'none' | 'vent' | 'frost' | 'spore';
}

export const BIOMES: Record<BiomeId, BiomeDef> = {
  ashwood: {
    id: 'ashwood',
    trees: [['pine', 5], ['oak', 3], ['dead', 1]],
    props: [['rock', 5], ['stump', 2], ['shroom', 2], ['crystal', 1]],
    treeDensity: 0.68,
    hill: 1,
    enemyHp: 1, enemySpeed: 1, weights: {}, hazard: 'none',
  },
  frostmere: {
    id: 'frostmere',
    trees: [['pine', 6], ['dead', 2]],
    props: [['rock', 4], ['ice', 4], ['crystal', 2]],
    treeDensity: 0.5,
    hill: 1.25,
    enemyHp: 1.12, enemySpeed: 0.95, weights: { wraith: 1.6, brute: 1.4, bomber: 0.6 }, hazard: 'frost',
  },
  emberwaste: {
    id: 'emberwaste',
    trees: [['dead', 4], ['cactus', 4]],
    props: [['rock', 6], ['bone', 3], ['crystal', 2]],
    treeDensity: 0.4,
    hill: 0.8,
    enemyHp: 0.95, enemySpeed: 1.06, weights: { bomber: 1.5, spitter: 1.2, husk: 1.2, skitter: 0.8 }, hazard: 'vent',
  },
  // a low, glowing fungal marsh: swarms and spitters, and spore blooms that linger
  gloommire: {
    id: 'gloommire',
    trees: [['dead', 3], ['oak', 3], ['pine', 1]],
    props: [['shroom', 7], ['crystal', 2], ['stump', 2], ['rock', 2]],
    treeDensity: 0.46,
    hill: 0.7,
    enemyHp: 1.29, enemySpeed: 1.07, weights: { skitter: 1.7, spitter: 1.5, husk: 1.3, wraith: 1.2, brute: 0.7 }, hazard: 'spore',
  },
};

export const WORLD_RADIUS = 150;
/** player cannot walk past this distance from the centre */
export const PLAY_RADIUS = 132;
export const SEA_LEVEL = -1.6;
export const BEACON_COUNT = 5;

function weighted<T>(rng: RNG, list: [T, number][]): T {
  let total = 0;
  for (const [, w] of list) total += w;
  let r = rng.next() * total;
  for (const [v, w] of list) {
    r -= w;
    if (r <= 0) return v;
  }
  return list[0][0];
}

function distToSeg(px: number, pz: number, s: PathSeg): number {
  const dx = s.bx - s.ax, dz = s.bz - s.az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - s.ax) * dx + (pz - s.az) * dz) / l2 : 0;
  t = clamp(t, 0, 1);
  const cx = s.ax + dx * t, cz = s.az + dz * t;
  return Math.hypot(px - cx, pz - cz);
}

export class World {
  readonly seed: number;
  readonly biome: BiomeDef;
  readonly radius = WORLD_RADIUS;
  readonly playRadius = PLAY_RADIUS;
  readonly beacons: BeaconSite[] = [];
  readonly obstacles: Obstacle[] = [];
  readonly decor: Decor[] = [];
  readonly paths: PathSeg[] = [];
  private noise: Noise2D;
  private noise2: Noise2D;
  // static obstacle grid
  private cell = 6;
  private gridN: number;
  private grid: Int32Array[]; // lists of obstacle indices

  constructor(seed: number, biome: BiomeId = 'ashwood') {
    this.seed = seed >>> 0;
    this.biome = BIOMES[biome];
    const rng = new RNG(this.seed);
    this.noise = new Noise2D(rng.int(1, 1e9));
    this.noise2 = new Noise2D(rng.int(1, 1e9));
    this.gridN = Math.ceil((WORLD_RADIUS * 2) / this.cell);
    this.genBeacons(rng);
    this.genPaths(rng);
    this.genObstacles(rng);
    this.genDecor(rng);
    const buckets: number[][] = [];
    for (let i = 0; i < this.gridN * this.gridN; i++) buckets.push([]);
    this.obstacles.forEach((o, i) => {
      const x0 = this.gi(o.x - o.r), x1 = this.gi(o.x + o.r);
      const z0 = this.gi(o.z - o.r), z1 = this.gi(o.z + o.r);
      for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) buckets[gz * this.gridN + gx].push(i);
    });
    this.grid = buckets.map((b) => Int32Array.from(b));
  }

  private gi(v: number): number {
    return clamp(Math.floor((v + WORLD_RADIUS) / this.cell), 0, this.gridN - 1);
  }

  private genBeacons(rng: RNG) {
    // one beacon per angular sector with jitter, alternating near / far rings
    const base = rng.angle();
    for (let i = 0; i < BEACON_COUNT; i++) {
      const a = base + (i / BEACON_COUNT) * Math.PI * 2 + rng.range(-0.28, 0.28);
      const d = i === 0 ? rng.range(48, 56) : rng.range(66, 108);
      this.beacons.push({ x: Math.cos(a) * d, z: Math.sin(a) * d });
    }
    // first beacon is the closest one: sort by distance so index order ~ difficulty order suggestion
    this.beacons.sort((p, q) => Math.hypot(p.x, p.z) - Math.hypot(q.x, q.z));
  }

  private genPaths(rng: RNG) {
    for (const b of this.beacons) {
      // curved polyline from centre to beacon
      const mx = b.x * 0.5, mz = b.z * 0.5;
      const len = Math.hypot(b.x, b.z);
      const nx = -b.z / len, nz = b.x / len;
      const bend = rng.range(-0.22, 0.22) * len;
      const cx = mx + nx * bend, cz = mz + nz * bend;
      let px = 0, pz = 0;
      const N = 14;
      for (let i = 1; i <= N; i++) {
        const t = i / N;
        const x = (1 - t) * (1 - t) * 0 + 2 * (1 - t) * t * cx + t * t * b.x;
        const z = (1 - t) * (1 - t) * 0 + 2 * (1 - t) * t * cz + t * t * b.z;
        this.paths.push({ ax: px, az: pz, bx: x, bz: z });
        px = x;
        pz = z;
      }
    }
  }

  /** distance to nearest path centreline */
  pathDist(x: number, z: number): number {
    let m = 1e9;
    for (const s of this.paths) {
      // cheap reject
      const minx = Math.min(s.ax, s.bx) - 8, maxx = Math.max(s.ax, s.bx) + 8;
      if (x < minx || x > maxx) continue;
      const minz = Math.min(s.az, s.bz) - 8, maxz = Math.max(s.az, s.bz) + 8;
      if (z < minz || z > maxz) continue;
      const d = distToSeg(x, z, s);
      if (d < m) m = d;
    }
    return m;
  }

  /** distance to the nearest clearing centre (start hearth or beacon), minus its radius */
  clearingDist(x: number, z: number): number {
    let m = Math.hypot(x, z) - 11;
    for (const b of this.beacons) {
      const d = Math.hypot(x - b.x, z - b.z) - 10;
      if (d < m) m = d;
    }
    return m;
  }

  private genObstacles(rng: RNG) {
    const tries = Math.floor(2600 * this.biome.treeDensity);
    const placed: Obstacle[] = this.obstacles;
    const minGap = 1.6;
    const tooClose = (x: number, z: number, r: number) => {
      for (let i = placed.length - 1; i >= 0; i--) {
        const o = placed[i];
        const dx = o.x - x, dz = o.z - z;
        const rr = o.r + r + minGap;
        if (dx * dx + dz * dz < rr * rr) return true;
      }
      return false;
    };
    // ruins: ring fragments near beacons and a few scattered sites
    const ruinSites: { x: number; z: number; r: number }[] = [];
    for (const b of this.beacons) ruinSites.push({ x: b.x, z: b.z, r: 9.2 });
    for (let i = 0; i < 6; i++) {
      const a = rng.angle(), d = rng.range(30, 115);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (this.clearingDist(x, z) > 14 && this.pathDist(x, z) > 7) ruinSites.push({ x, z, r: rng.range(4, 7) });
    }
    ruinSites.push({ x: 0, z: 0, r: 10.2 });
    for (const site of ruinSites) {
      const n = Math.round(site.r * 1.1);
      const off = rng.angle();
      for (let i = 0; i < n; i++) {
        if (rng.chance(0.42)) continue;
        const a = off + (i / n) * Math.PI * 2;
        const x = site.x + Math.cos(a) * site.r, z = site.z + Math.sin(a) * site.r;
        if (this.pathDist(x, z) < 3.2) continue;
        const isWall = rng.chance(0.3);
        placed.push({
          x, z,
          r: isWall ? 1.25 : 0.75,
          kind: isWall ? 'wall' : 'pillar',
          s: rng.range(0.85, 1.25),
          rot: -a + Math.PI / 2 + rng.range(-0.15, 0.15),
          variant: rng.int(0, 3),
        });
      }
    }
    // forest: density from low-frequency noise so we get groves and glades
    for (let i = 0; i < tries; i++) {
      const a = rng.angle();
      const d = Math.sqrt(rng.next()) * (PLAY_RADIUS + 10);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const dens = this.noise2.fbm(x * 0.018 + 40, z * 0.018 - 17, 3) * 0.5 + 0.5;
      if (rng.next() > smoothstep(0.32, 0.62, dens) * 0.95 + 0.05) continue;
      if (this.clearingDist(x, z) < 2.5) continue;
      if (this.pathDist(x, z) < 3.4) continue;
      const kind = weighted(rng, this.biome.trees);
      const s = rng.range(0.8, 1.45) * (kind === 'oak' ? 1.1 : 1);
      const r = kind === 'cactus' ? 0.55 : 0.5 * s;
      if (tooClose(x, z, r)) continue;
      placed.push({ x, z, r, kind, s, rot: rng.angle(), variant: rng.int(0, 3) });
    }
    // props: rocks etc.
    for (let i = 0; i < 520; i++) {
      const a = rng.angle();
      const d = Math.sqrt(rng.next()) * (PLAY_RADIUS + 12);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (this.clearingDist(x, z) < 1.5) continue;
      if (this.pathDist(x, z) < 3.0) continue;
      const kind = weighted(rng, this.biome.props);
      let s = rng.range(0.7, 1.5);
      let r = 0.8 * s;
      if (kind === 'rock') {
        s = rng.chance(0.14) ? rng.range(1.9, 3.0) : rng.range(0.6, 1.5);
        r = 0.95 * s;
      } else if (kind === 'stump') r = 0.55 * s;
      else if (kind === 'shroom') r = 0.45 * s;
      else if (kind === 'crystal') r = 0.7 * s;
      else if (kind === 'ice') r = 0.9 * s;
      else if (kind === 'bone') r = 0.8 * s;
      if (tooClose(x, z, r)) continue;
      placed.push({ x, z, r, kind, s, rot: rng.angle(), variant: rng.int(0, 3) });
    }
  }

  private genDecor(rng: RNG) {
    const N = 15000;
    for (let i = 0; i < N; i++) {
      const a = rng.angle();
      const d = Math.sqrt(rng.next()) * (PLAY_RADIUS + 13);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const pd = this.pathDist(x, z);
      if (pd < 1.3) continue;
      if (Math.hypot(x, z) < 3.2) continue;
      let nearBeacon = false;
      for (const b of this.beacons) if (Math.hypot(x - b.x, z - b.z) < 3.4) nearBeacon = true;
      if (nearBeacon) continue;
      const n = this.noise.fbm(x * 0.05 + 9, z * 0.05 + 3, 2) * 0.5 + 0.5;
      const roll = rng.next();
      let kind = 0;
      if (roll > 0.955) kind = 1;
      else if (roll > 0.93) kind = 2;
      else if (roll > 0.89) kind = 3;
      else if (roll > 0.8) kind = 4;
      if (kind === 0 && rng.next() > n * 1.25) continue;
      this.decor.push({ x, z, kind, s: rng.range(0.7, 1.4), rot: rng.angle(), tint: rng.next() });
    }
  }

  /** Terrain height. Pure function of (x,z) so the simulation and renderer agree. */
  height(x: number, z: number): number {
    const d = Math.hypot(x, z);
    const hill = this.biome.hill;
    let h = this.noise.fbm(x * 0.022, z * 0.022, 4) * 4.2 * hill;
    h += this.noise2.get(x * 0.09, z * 0.09) * 0.45;
    // flatten clearings
    const cd = this.clearingDist(x, z);
    const flat = smoothstep(9, -3, cd);
    h = lerp(h, h * 0.25 + 0.2, flat);
    // paths are slightly sunken
    const pd = this.pathDist(x, z);
    h -= smoothstep(3.2, 0.6, pd) * 0.22;
    // island falloff into the sea
    const edge = smoothstep(PLAY_RADIUS - 6, WORLD_RADIUS + 2, d);
    h = lerp(h + 0.9, -5.5, edge * edge * (3 - 2 * edge));
    // beyond the island: seabed
    if (d > WORLD_RADIUS) h = lerp(h, -9, smoothstep(WORLD_RADIUS, WORLD_RADIUS + 30, d));
    return h;
  }

  /** Push a circle out of static obstacles. Returns true when a collision was resolved. Mutates `p`. */
  resolve(p: { x: number; z: number }, r: number): boolean {
    const x0 = this.gi(p.x - r), x1 = this.gi(p.x + r);
    const z0 = this.gi(p.z - r), z1 = this.gi(p.z + r);
    let hit = false;
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const list = this.grid[gz * this.gridN + gx];
        for (let k = 0; k < list.length; k++) {
          const o = this.obstacles[list[k]];
          const dx = p.x - o.x, dz = p.z - o.z;
          const rr = o.r + r;
          const d2 = dx * dx + dz * dz;
          if (d2 < rr * rr) {
            const d = Math.sqrt(d2) || 0.0001;
            const push = rr - d;
            p.x += (dx / d) * push;
            p.z += (dz / d) * push;
            hit = true;
          }
        }
      }
    }
    return hit;
  }

  /** true if the point is inside any obstacle (used by spawner) */
  blocked(x: number, z: number, r: number): boolean {
    const x0 = this.gi(x - r), x1 = this.gi(x + r);
    const z0 = this.gi(z - r), z1 = this.gi(z + r);
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const list = this.grid[gz * this.gridN + gx];
        for (let k = 0; k < list.length; k++) {
          const o = this.obstacles[list[k]];
          const dx = x - o.x, dz = z - o.z;
          const rr = o.r + r;
          if (dx * dx + dz * dz < rr * rr) return true;
        }
      }
    }
    return false;
  }
}
