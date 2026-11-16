import { RNG, clamp } from '../core/rng';
import {
  CHARS, DIFFICULTIES, ENEMIES, META, PASSIVES, WEAPONS,
  type CharDef, type CharId, type DifficultyDef, type EnemyKind, type MetaId, type PassiveId, type RelicId, type WeaponId,
} from './defs';
import { World, type BiomeId } from './worldgen';
import type {
  Beacon, EProj, Enemy, InputState, Pending, Pickup, PickupKind, Player, Proj, RunStats, SimEvent, Stats, WeaponInst, Zone,
} from './types';
import { updateEnemies, updateDirector, initDirector, type DirectorState } from './ai';
import { updateWeapons, updateProjs, updateZones, updateEProjs } from './weapons';
import { makeChestPending, makeLevelPending, makeRelicPending } from './choices';

export interface RunConfig {
  seed: number;
  char: CharId;
  difficulty: number;
  biome: BiomeId;
  meta: Partial<Record<MetaId, number>>;
}

/** Uniform spatial hash for enemies. Rebuilt every step. */
class Grid {
  readonly cell = 4;
  readonly n: number;
  private half: number;
  private head: Int32Array;
  private next: Int32Array;
  constructor(half: number, cap: number) {
    this.half = half;
    this.n = Math.ceil((half * 2) / this.cell);
    this.head = new Int32Array(this.n * this.n);
    this.next = new Int32Array(cap);
  }
  private ci(v: number): number {
    const c = Math.floor((v + this.half) / this.cell);
    return c < 0 ? 0 : c >= this.n ? this.n - 1 : c;
  }
  rebuild(list: Enemy[]) {
    this.head.fill(-1);
    if (list.length > this.next.length) this.next = new Int32Array(list.length * 2);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const c = this.ci(e.z) * this.n + this.ci(e.x);
      this.next[i] = this.head[c];
      this.head[c] = i;
    }
  }
  /** collect alive enemies whose circle overlaps the query circle */
  query(list: Enemy[], x: number, z: number, r: number, out: Enemy[]) {
    const pad = r + 1.5;
    const x0 = this.ci(x - pad), x1 = this.ci(x + pad);
    const z0 = this.ci(z - pad), z1 = this.ci(z + pad);
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        let i = this.head[gz * this.n + gx];
        while (i >= 0) {
          const e = list[i];
          if (e.alive) {
            const dx = e.x - x, dz = e.z - z;
            const rr = r + e.r;
            if (dx * dx + dz * dz < rr * rr) out.push(e);
          }
          i = this.next[i];
        }
      }
    }
  }
}

export interface Blast {
  x: number;
  z: number;
  r: number;
  dmg: number;
  w: WeaponId | null;
  kb: number;
  burn: number;
  c: number;
}

export class Sim {
  readonly cfg: RunConfig;
  readonly world: World;
  readonly rng: RNG;
  readonly diff: DifficultyDef;
  readonly char: CharDef;
  time = 0;
  state: 'playing' | 'dead' | 'victory' = 'playing';
  player: Player;
  enemies: Enemy[] = [];
  /** large enemies that are not stored in the grid (bosses) */
  bigs: Enemy[] = [];
  projs: Proj[] = [];
  eprojs: EProj[] = [];
  zones: Zone[] = [];
  pickups: Pickup[] = [];
  beacons: Beacon[];
  events: SimEvent[] = [];
  pending: Pending[] = [];
  blasts: Blast[] = [];
  stats: RunStats = { kills: 0, eliteKills: 0, dmgDealt: 0, dmgTaken: 0, cinders: 0, beacons: 0, bossKilled: false, maxCombo: 0, healed: 0 };
  boss: Enemy | null = null;
  dir: DirectorState;
  banished = new Set<string>();
  combo = 0;
  comboT = 0;
  hitCounter = 0;
  /** countdown after the final boss dies before the victory state */
  endT = -1;
  /** countdown between last beacon and boss arrival */
  bossT = -1;
  private grid: Grid;
  private scratch: Enemy[][] = [];
  private scratchI = 0;
  private idc = 1;
  private xpCount = 0;

  constructor(cfg: RunConfig) {
    this.cfg = cfg;
    this.rng = new RNG(cfg.seed ^ 0x5bd1e995);
    this.world = new World(cfg.seed, cfg.biome);
    this.diff = DIFFICULTIES[clamp(cfg.difficulty, 0, DIFFICULTIES.length - 1)];
    this.char = CHARS[cfg.char];
    this.grid = new Grid(this.world.radius + 8, 1024);
    for (let i = 0; i < 8; i++) this.scratch.push([]);
    this.beacons = this.world.beacons.map((b) => ({ x: b.x, z: b.z, progress: 0, lit: false, channeling: false, pulseT: 0, guard: false, litAt: 0 }));
    const m = (id: MetaId) => cfg.meta[id] ?? 0;
    this.player = {
      x: 0, z: 2.5, vx: 0, vz: 0, facing: Math.PI / 2, aim: Math.PI / 2,
      hp: 1, level: 1, xp: 0, xpNext: this.xpNeed(1),
      iframe: 0, dashT: 0, dashCdT: 0, dashCharges: 1, slowT: 0, dashX: 0, dashZ: 1,
      moving: false, hurtT: 0, revives: m('m_revive'),
      weapons: [], passives: [], relics: [],
      st: {} as Stats,
      rerolls: 1 + m('m_reroll'), banishes: m('m_banish'), alive: true,
    };
    this.player.weapons.push({ id: this.char.weapon, level: 1, t: 0.4, a: 0, b: 0, dealt: 0 });
    this.recalc();
    this.player.hp = this.player.st.maxHp;
    this.player.dashCharges = this.player.st.dashMax;
    this.dir = initDirector();
  }

  id(): number {
    return this.idc++;
  }

  xpNeed(level: number): number {
    return Math.floor(6 + 5 * level + 0.9 * level * level);
  }

  /** intensity scalar driving spawn rate and enemy scaling */
  intensity(): number {
    return this.time / 60 + this.stats.beacons * 1.4;
  }

  passiveLevel(id: PassiveId): number {
    for (const p of this.player.passives) if (p.id === id) return p.level;
    return 0;
  }

  hasRelic(id: RelicId): boolean {
    return this.player.relics.indexOf(id) >= 0;
  }

  weapon(id: WeaponId): WeaponInst | undefined {
    for (const w of this.player.weapons) if (w.id === id) return w;
    return undefined;
  }

  /** Recompute derived stats from character, meta upgrades, passives and relics. */
  recalc() {
    const c = this.char;
    const p = this.player;
    const m = (id: MetaId) => (this.cfg.meta[id] ?? 0) * (META.find((d) => d.id === id)?.per ?? 0);
    const pl = (id: PassiveId) => this.passiveLevel(id) * PASSIVES[id].per;
    const old = p.st.maxHp || 0;
    const st: Stats = {
      maxHp: c.hp * (1 + m('m_hp') / 100 + pl('vigor') / 100),
      regen: m('m_regen') + pl('mending'),
      armor: c.armor + m('m_armor') + pl('plating'),
      speed: c.speed * (1 + m('m_speed') / 100 + pl('swift') / 100),
      might: c.might * (1 + m('m_might') / 100 + pl('might') / 100),
      haste: c.haste * (1 + m('m_haste') / 100 + pl('haste') / 100),
      area: c.area * (1 + pl('reach') / 100),
      projSpeed: 1 + pl('velocity') / 100,
      dur: 1 + pl('velocity') / 100,
      amount: pl('multishot'),
      crit: 0.05 + pl('focus') / 100,
      critMul: 2 + this.passiveLevel('focus') * 0.1,
      pickup: 3.4 * (1 + m('m_magnet') / 100 + pl('magnet') / 100),
      xp: c.xp * (1 + m('m_xp') / 100 + pl('wisdom') / 100),
      luck: 1 + m('m_luck') / 100 + pl('fortune') / 100,
      cinder: 1 + m('m_cinder') / 100 + pl('fortune') / 200,
      dashMax: c.dashCharges,
      dashCd: 2.6,
    };
    for (const r of p.relics) {
      switch (r) {
        case 'twinflame': st.amount += 1; break;
        case 'glasslantern': st.might *= 1.4; st.maxHp *= 0.75; break;
        case 'secondwind': st.dashMax += 1; st.dashCd *= 0.8; break;
        case 'gildedwick': st.cinder += 0.5; break;
        case 'wideglow': st.area *= 1.25; break;
        case 'quickening': st.haste *= 1.15; break;
        case 'titanash': st.maxHp += 60; st.armor += 2; st.speed *= 0.93; break;
        case 'starmoss': st.regen += 1.2; break;
        default: break;
      }
    }
    st.maxHp = Math.round(st.maxHp);
    p.st = st;
    if (old > 0 && st.maxHp > old) p.hp += st.maxHp - old;
    if (p.hp > st.maxHp) p.hp = st.maxHp;
  }

  // ------------------------------------------------------------ queries
  /** Alive enemies overlapping a circle. The returned array is scratch storage: valid until 8 further calls. */
  near(x: number, z: number, r: number): Enemy[] {
    const out = this.scratch[this.scratchI];
    this.scratchI = (this.scratchI + 1) & 7;
    out.length = 0;
    this.grid.query(this.enemies, x, z, r, out);
    for (let i = 0; i < this.bigs.length; i++) {
      const e = this.bigs[i];
      if (!e.alive) continue;
      const dx = e.x - x, dz = e.z - z, rr = r + e.r;
      if (dx * dx + dz * dz < rr * rr) out.push(e);
    }
    return out;
  }

  /** nearest alive enemy to a point within maxDist (centre distance), optionally skipping a set */
  nearest(x: number, z: number, maxDist: number, skip?: Set<number>): Enemy | null {
    let best: Enemy | null = null;
    let bd = maxDist * maxDist;
    const scan = (list: Enemy[]) => {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e.alive || e.spawn < 0.5) continue;
        if (skip && skip.has(e.id)) continue;
        const dx = e.x - x, dz = e.z - z;
        const d = dx * dx + dz * dz;
        if (d < bd) {
          bd = d;
          best = e;
        }
      }
    };
    if (maxDist <= 12) {
      const list = this.near(x, z, maxDist);
      scan(list);
    } else {
      scan(this.enemies);
      scan(this.bigs);
    }
    return best;
  }

  /** resolve the direction weapons should fire in */
  aimDir(input: InputState, range = 26): { x: number; z: number } {
    const p = this.player;
    if (input.autoAim) {
      const e = this.nearest(p.x, p.z, range);
      if (e) {
        const dx = e.x - p.x, dz = e.z - p.z;
        const d = Math.hypot(dx, dz) || 1;
        return { x: dx / d, z: dz / d };
      }
      return { x: Math.cos(p.facing), z: Math.sin(p.facing) };
    }
    return { x: input.aimX, z: input.aimZ };
  }

  // ------------------------------------------------------------ damage
  damageEnemy(e: Enemy, base: number, w: WeaponId | null, kb = 0, sx = 0, sz = 0, noCrit = false): number {
    if (!e.alive) return 0;
    const p = this.player;
    let d = base * p.st.might;
    let crit = false;
    if (!noCrit && this.rng.next() < p.st.crit) {
      d *= p.st.critMul;
      crit = true;
    }
    if ((e.chillT > 0 || e.freezeT > 0) && this.hasRelic('frozencore')) d *= 1.3;
    if ((e.elite || e.boss) && this.hasRelic('huntersmark')) d *= 1.35;
    return this.applyDamage(e, d, w, crit, kb, sx, sz);
  }

  /** apply final damage (no multipliers) */
  applyDamage(e: Enemy, d: number, w: WeaponId | null, crit: boolean, kb = 0, sx = 0, sz = 0, silent = false): number {
    if (!e.alive) return 0;
    if (e.spawn < 0.35) d *= 0.5;
    if (e.affix === 5) d *= 0.55;
    e.hp -= d;
    e.flash = 1;
    this.stats.dmgDealt += d;
    if (w) {
      const wi = this.weapon(w);
      if (wi) wi.dealt += d;
    }
    if (kb > 0 && e.def.mass < 100) {
      let dx = e.x - sx, dz = e.z - sz;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const k = kb / e.def.mass;
      e.kx += dx * k;
      e.kz += dz * k;
    }
    const kill = e.hp <= 0;
    if (!silent) this.events.push({ t: 'hit', x: e.x, z: e.z, dmg: d, crit, w, kill, big: e.boss || e.elite });
    if (kill) this.kill(e);
    else if (w && this.hasRelic('stormheart')) {
      if (++this.hitCounter >= 14) {
        this.hitCounter = 0;
        this.freeArc(e);
      }
    }
    return d;
  }

  private freeArc(from: Enemy) {
    const pts: number[] = [this.player.x, this.player.z, from.x, from.z];
    const skip = new Set<number>([from.id]);
    let cur = from;
    for (let i = 0; i < 4; i++) {
      const n = this.nearest(cur.x, cur.z, 8, skip);
      if (!n) break;
      skip.add(n.id);
      pts.push(n.x, n.z);
      this.applyDamage(n, 22 * this.player.st.might, null, false);
      cur = n;
    }
    if (pts.length > 4) this.events.push({ t: 'lightning', pts });
  }

  burn(e: Enemy, dps: number, dur: number) {
    if (!e.alive) return;
    const d = dps * this.player.st.might;
    if (d > e.burnDps || e.burnT <= 0) e.burnDps = d;
    if (dur > e.burnT) e.burnT = dur;
  }

  chill(e: Enemy, dur: number) {
    if (e.boss) dur *= 0.4;
    if (dur > e.chillT) e.chillT = dur;
  }

  freeze(e: Enemy, dur: number) {
    if (e.boss || !e.alive) return;
    if (e.freezeT <= 0) this.events.push({ t: 'freeze', x: e.x, z: e.z });
    if (dur > e.freezeT) e.freezeT = dur;
  }

  kill(e: Enemy) {
    if (!e.alive) return;
    e.alive = false;
    this.stats.kills++;
    this.combo++;
    this.comboT = 2;
    if (this.combo > this.stats.maxCombo) this.stats.maxCombo = this.combo;
    this.events.push({ t: 'kill', x: e.x, z: e.z, kind: e.kind, elite: e.elite || e.boss, r: e.r });
    const p = this.player;
    // drops
    if (e.def.xp > 0) this.dropXp(e.x, e.z, e.def.xp * (e.elite ? 12 : 1) * (1 + this.intensity() * 0.02));
    const luck = p.st.luck;
    if (e.elite) {
      this.stats.eliteKills++;
      this.spawnPickup('chest', e.x, e.z, 1);
      for (let i = 0; i < 3; i++) this.spawnPickup('cinder', e.x + this.rng.range(-1, 1), e.z + this.rng.range(-1, 1), 3);
    } else if (!e.boss) {
      const roll = this.rng.next();
      if (roll < 0.006 * luck) this.spawnPickup('heal', e.x, e.z, 1);
      else if (roll < 0.0075 * luck) this.spawnPickup('magnet', e.x, e.z, 1);
      else if (roll < 0.03 * luck) this.spawnPickup('cinder', e.x, e.z, 1);
    }
    if (e.affix === 3) {
      // volatile: leaves a delayed blast where it fell
      this.zones.push({ id: this.id(), kind: 'slam', x: e.x, z: e.z, r: 5.2, t: 0, dur: 1.0, dmg: e.dmg * 1.2, tick: 0, hostile: true, weapon: null, evolved: false, dx: 0, dz: 0, len: 0, alive: true });
    } else if (e.affix === 4) {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        this.spawnEnemy(e.kind, e.x + Math.cos(a) * 1.3, e.z + Math.sin(a) * 1.3, false, 0.5);
      }
    }
    if (e.kind === 'husk') {
      for (let i = 0; i < 3; i++) {
        const a = this.rng.angle();
        this.spawnEnemy('skitter', e.x + Math.cos(a) * 0.8, e.z + Math.sin(a) * 0.8, false, 0.6);
      }
    }
    if (e.burnT > 0 && this.hasRelic('emberbloom')) {
      this.blasts.push({ x: e.x, z: e.z, r: 2.8, dmg: 14 + e.maxHp * 0.18, w: null, kb: 3, burn: 0, c: 0xff8a3c });
    }
    if (this.hasRelic('bloodember') && this.rng.next() < 0.07) this.heal(1, true);
    if (e.kind === 'herald') {
      this.events.push({ t: 'bossDie', x: e.x, z: e.z, kind: e.kind });
      this.spawnPickup('chest', e.x, e.z, 1);
      for (let i = 0; i < 6; i++) this.spawnPickup('cinder', e.x + this.rng.range(-2, 2), e.z + this.rng.range(-2, 2), 4);
    }
    if (e.kind === 'eclipse') {
      this.stats.bossKilled = true;
      this.boss = null;
      this.endT = 5.5;
      this.events.push({ t: 'bossDie', x: e.x, z: e.z, kind: e.kind });
      // the night breaks: everything else dies
      for (const o of this.enemies) if (o.alive) this.killQuiet(o);
      for (const o of this.bigs) if (o.alive && o !== e) this.killQuiet(o);
      for (const b of this.eprojs) b.alive = false;
      for (const z of this.zones) if (z.hostile) z.alive = false;
      this.stats.cinders += 100;
    }
    if (this.boss === e) this.boss = null;
  }

  private killQuiet(e: Enemy) {
    e.alive = false;
    this.stats.kills++;
    this.events.push({ t: 'kill', x: e.x, z: e.z, kind: e.kind, elite: e.elite, r: e.r });
  }

  dropXp(x: number, z: number, v: number) {
    if (this.xpCount > 420) {
      // merge into an existing gem to bound entity count
      for (let tries = 0; tries < 6; tries++) {
        const k = this.pickups[Math.floor(this.rng.next() * this.pickups.length)];
        if (k && k.alive && k.kind === 'xp') {
          k.v += v;
          return;
        }
      }
    }
    this.spawnPickup('xp', x, z, v);
  }

  spawnPickup(kind: PickupKind, x: number, z: number, v: number) {
    const a = this.rng.angle();
    const s = kind === 'xp' ? this.rng.range(0.5, 2.5) : this.rng.range(2, 4.5);
    if (kind === 'xp') this.xpCount++;
    this.pickups.push({ id: this.id(), kind, x, z, v, pull: false, t: 0, vx: Math.cos(a) * s, vz: Math.sin(a) * s, alive: true });
  }

  heal(v: number, quiet = false) {
    const p = this.player;
    if (!p.alive) return;
    const before = p.hp;
    p.hp = Math.min(p.st.maxHp, p.hp + v);
    const got = p.hp - before;
    this.stats.healed += got;
    if (!quiet && got > 0.5) this.events.push({ t: 'heal', v: got });
  }

  hurtPlayer(dmg: number, sx: number, sz: number): boolean {
    const p = this.player;
    if (!p.alive || p.iframe > 0 || this.state !== 'playing' || this.endT >= 0) return false;
    // past the 18 minute mark the night turns lethal, so no vigil can stall forever
    const late = Math.max(0, this.time / 60 - 18);
    const mult = (1 + 0.04 * this.intensity()) * (1 + late * 0.15) * this.diff.dmg;
    const d = Math.max(1, Math.round(dmg * mult - p.st.armor));
    p.hp -= d;
    p.iframe = 0.55;
    p.hurtT = 0.35;
    this.stats.dmgTaken += d;
    this.events.push({ t: 'hurt', dmg: d, x: sx, z: sz });
    if (p.hp <= 0) {
      if (p.revives > 0) {
        p.revives--;
        p.hp = p.st.maxHp * 0.5;
        p.iframe = 2.5;
        this.events.push({ t: 'revive', x: p.x, z: p.z });
        this.blasts.push({ x: p.x, z: p.z, r: 11, dmg: 120 + this.intensity() * 30, w: null, kb: 22, burn: 0, c: 0xffd98a });
        this.events.push({ t: 'nova', x: p.x, z: p.z, r: 11, c: 0xffd98a });
      } else {
        p.hp = 0;
        p.alive = false;
        this.state = 'dead';
        this.events.push({ t: 'death', x: p.x, z: p.z });
      }
    }
    return true;
  }

  // ------------------------------------------------------------ spawning
  spawnEnemy(kind: EnemyKind, x: number, z: number, elite = false, spawn = 0): Enemy {
    const def = ENEMIES[kind];
    const I = this.intensity();
    const boss = kind === 'herald' || kind === 'eclipse';
    let hpMul = (1 + 0.11 * I + 0.011 * I * I) * this.diff.hp;
    // bosses scale with the clock only: rushing the beacons must not buy an easier fight
    if (boss) hpMul = (1 + 0.045 * (this.time / 60)) * (kind === 'herald' ? 1 + 0.35 * this.stats.beacons : 1) * this.diff.hp;
    const biome = this.world.biome;
    if (!boss) hpMul *= biome.enemyHp;
    const scale = elite ? 1.45 : 1;
    const e: Enemy = {
      id: this.id(), kind, def, x, z, kx: 0, kz: 0,
      hp: def.hp * hpMul * (elite ? 9 : 1), maxHp: 0,
      r: def.radius * scale, speed: def.speed * (elite ? 1.08 : 1) * (boss ? 1 : biome.enemySpeed) * this.rng.range(0.94, 1.06), dmg: def.dmg * (elite ? 1.4 : 1),
      alive: true, elite, boss, flash: 0, burnT: 0, burnDps: 0, burnAcc: 0, chillT: 0, freezeT: 0,
      t: 0, st: 0, stT: 0, ax: 0, az: 0, n: 0, face: 0, cdA: 0, cdB: 0, seed: this.rng.next(), spawn, scale, tele: 0, affix: 0, phase: 1, c1: 0, lx: 0, lz: 0, ll: 0,
    };
    e.maxHp = e.hp;
    if (boss) this.bigs.push(e);
    else this.enemies.push(e);
    return e;
  }

  /** a valid spawn point on a ring around the player */
  ringPoint(minD: number, maxD: number, r = 0.6, biasAngle?: number): { x: number; z: number } {
    const p = this.player;
    const lim = this.world.playRadius + 3;
    for (let i = 0; i < 12; i++) {
      const a = biasAngle !== undefined && i < 6 ? biasAngle + this.rng.range(-0.9, 0.9) : this.rng.angle();
      const d = this.rng.range(minD, maxD);
      const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
      if (x * x + z * z > lim * lim) continue;
      if (this.world.blocked(x, z, r)) continue;
      return { x, z };
    }
    // fallback: toward the island centre
    const a = Math.atan2(-p.z, -p.x) + this.rng.range(-0.6, 0.6);
    const d = Math.min(minD, Math.hypot(p.x, p.z) + 6);
    return { x: p.x + Math.cos(a) * d, z: p.z + Math.sin(a) * d };
  }

  // ------------------------------------------------------------ main step
  step(dt: number, input: InputState) {
    if (this.state !== 'playing' || this.pending.length > 0) return;
    if (dt > 1 / 40) {
      // split long frames to keep collisions stable
      const h = dt / 2;
      this.substep(h, input);
      input = { ...input, dash: false };
      if (this.state === 'playing' && this.pending.length === 0) this.substep(h, input);
    } else this.substep(dt, input);
  }

  private substep(dt: number, input: InputState) {
    this.time += dt;
    this.compact();
    this.grid.rebuild(this.enemies);
    this.updatePlayer(dt, input);
    updateDirector(this, dt);
    updateEnemies(this, dt);
    if (this.endT < 0) updateWeapons(this, dt, input);
    updateProjs(this, dt);
    updateEProjs(this, dt);
    updateZones(this, dt);
    this.flushBlasts();
    this.updatePickups(dt);
    this.updateBeacons(dt);
    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.combo = 0;
    }
    if (this.endT >= 0) {
      this.endT -= dt;
      if (this.endT < 0 && this.state === 'playing') {
        this.state = 'victory';
        this.events.push({ t: 'victory' });
      }
    }
  }

  flushBlasts() {
    let guard = 0;
    while (this.blasts.length > 0 && guard++ < 200) {
      const b = this.blasts.pop()!;
      const list = this.near(b.x, b.z, b.r);
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        this.damageEnemy(e, b.dmg, b.w, b.kb, b.x, b.z);
        if (b.burn > 0) this.burn(e, b.burn, 3);
      }
      this.events.push({ t: 'explode', x: b.x, z: b.z, r: b.r, c: b.c, hostile: false });
    }
    this.blasts.length = 0;
  }

  private compact() {
    const sweep = <T extends { alive: boolean }>(arr: T[]) => {
      let j = 0;
      for (let i = 0; i < arr.length; i++) if (arr[i].alive) arr[j++] = arr[i];
      arr.length = j;
    };
    sweep(this.enemies);
    sweep(this.bigs);
    sweep(this.projs);
    sweep(this.eprojs);
    sweep(this.zones);
    sweep(this.pickups);
  }

  private updatePlayer(dt: number, input: InputState) {
    const p = this.player;
    const st = p.st;
    if (p.iframe > 0) p.iframe -= dt;
    if (p.hurtT > 0) p.hurtT -= dt;
    if (st.regen > 0 && p.hp < st.maxHp) {
      p.hp = Math.min(st.maxHp, p.hp + st.regen * dt);
    }
    // dash recharge
    if (p.dashCharges < st.dashMax) {
      p.dashCdT += dt;
      if (p.dashCdT >= st.dashCd) {
        p.dashCdT = 0;
        p.dashCharges++;
      }
    } else p.dashCdT = 0;
    let mx = input.mx, mz = input.mz;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) {
      mx /= ml;
      mz /= ml;
    }
    p.moving = ml > 0.1;
    if (input.dash && p.dashT <= 0 && p.dashCharges > 0) {
      p.dashCharges--;
      p.dashT = 0.2;
      if (p.moving) {
        p.dashX = mx / Math.max(ml > 1 ? 1 : ml, 0.001);
        p.dashZ = mz / Math.max(ml > 1 ? 1 : ml, 0.001);
        const l = Math.hypot(p.dashX, p.dashZ) || 1;
        p.dashX /= l;
        p.dashZ /= l;
      } else {
        p.dashX = Math.cos(p.facing);
        p.dashZ = Math.sin(p.facing);
      }
      p.iframe = Math.max(p.iframe, 0.34);
      this.events.push({ t: 'dash', x: p.x, z: p.z });
    }
    if (p.dashT > 0) {
      p.dashT -= dt;
      const sp = st.speed * 3.6;
      p.vx = p.dashX * sp;
      p.vz = p.dashZ * sp;
      if (p.dashT <= 0) {
        p.vx *= 0.35;
        p.vz *= 0.35;
        if (this.hasRelic('afterimage')) {
          this.blasts.push({ x: p.x, z: p.z, r: 4.6, dmg: 38 + this.intensity() * 4, w: null, kb: 10, burn: 0, c: 0xc6a2ff });
          this.events.push({ t: 'nova', x: p.x, z: p.z, r: 4.6, c: 0xc6a2ff });
        }
      }
    } else {
      const k = 1 - Math.exp(-16 * dt);
      const sp = st.speed * (p.slowT > 0 ? 0.62 : 1);
      p.vx += (mx * sp - p.vx) * k;
      p.vz += (mz * sp - p.vz) * k;
    }
    if (p.slowT > 0) p.slowT -= dt;
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    this.world.resolve(p, 0.5);
    const d = Math.hypot(p.x, p.z);
    if (d > this.world.playRadius) {
      p.x *= this.world.playRadius / d;
      p.z *= this.world.playRadius / d;
    }
    if (p.moving) {
      const target = Math.atan2(mz, mx);
      let da = target - p.facing;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      p.facing += da * (1 - Math.exp(-14 * dt));
    }
    const ad = this.aimDir(input);
    p.aim = Math.atan2(ad.z, ad.x);
  }

  addXp(v: number) {
    const p = this.player;
    p.xp += v * p.st.xp;
    let guard = 0;
    while (p.xp >= p.xpNext && guard++ < 20) {
      p.xp -= p.xpNext;
      p.level++;
      p.xpNext = this.xpNeed(p.level);
      this.events.push({ t: 'levelup', level: p.level });
      this.pending.push(makeLevelPending(this));
    }
  }

  private updatePickups(dt: number) {
    const p = this.player;
    const pr = p.st.pickup;
    const pr2 = pr * pr;
    let xpN = 0;
    for (let i = 0; i < this.pickups.length; i++) {
      const k = this.pickups[i];
      if (!k.alive) continue;
      k.t += dt;
      if (k.kind === 'xp') xpN++;
      const dx = p.x - k.x, dz = p.z - k.z;
      const d2 = dx * dx + dz * dz;
      if (!k.pull) {
        // initial scatter drift
        k.x += k.vx * dt;
        k.z += k.vz * dt;
        const f = Math.exp(-5 * dt);
        k.vx *= f;
        k.vz *= f;
        const reach = k.kind === 'chest' ? 2.2 : pr;
        if (d2 < reach * reach && k.t > 0.25) k.pull = true;
        if (k.kind !== 'xp' && k.kind !== 'chest' && d2 < pr2 * 1.2) k.pull = true;
      } else {
        const d = Math.sqrt(d2) || 0.001;
        const sp = Math.min(34, 9 + k.t * 30);
        k.x += (dx / d) * sp * dt;
        k.z += (dz / d) * sp * dt;
        if (d < 0.9 || sp * dt > d) {
          k.alive = false;
          this.collect(k);
        }
      }
    }
    this.xpCount = xpN;
  }

  private collect(k: Pickup) {
    const p = this.player;
    this.events.push({ t: 'pickup', kind: k.kind, v: k.v, x: k.x, z: k.z });
    switch (k.kind) {
      case 'xp':
        this.addXp(k.v);
        break;
      case 'heal':
        this.heal(p.st.maxHp * (this.hasRelic('starmoss') ? 0.4 : 0.22));
        break;
      case 'magnet':
        for (const o of this.pickups) if (o.alive && o.kind !== 'chest') o.pull = true;
        break;
      case 'cinder':
        this.stats.cinders += k.v;
        break;
      case 'chest':
        this.pending.push(makeChestPending(this));
        break;
    }
  }

  private updateBeacons(dt: number) {
    const p = this.player;
    const I = this.intensity();
    const bond = this.hasRelic('beaconbond');
    let allLit = true;
    for (let i = 0; i < this.beacons.length; i++) {
      const b = this.beacons[i];
      const dx = p.x - b.x, dz = p.z - b.z;
      const d = Math.hypot(dx, dz);
      if (b.lit) {
        b.pulseT += dt;
        const pr = bond ? 14 : 8.5;
        if (bond && d < pr) this.heal(2 * dt, true);
        if (b.pulseT >= 2.4) {
          b.pulseT = 0;
          if (d < 60) {
            const list = this.near(b.x, b.z, pr);
            const dmg = (18 + 7 * I) * (bond ? 2 : 1);
            for (let k = 0; k < list.length; k++) {
              const e = list[k];
              if (e.boss) continue;
              this.applyDamage(e, dmg, null, false, 6, b.x, b.z);
              this.burn(e, dmg * 0.3, 2);
            }
            this.events.push({ t: 'beaconPulse', i, x: b.x, z: b.z, r: pr });
          }
        }
        continue;
      }
      allLit = false;
      const was = b.channeling;
      b.channeling = d < 6.5 && p.alive;
      if (b.channeling) {
        if (!was && b.progress < 0.02) {
          this.events.push({ t: 'beaconStart', i });
          this.events.push({ t: 'announce', key: 'ann.channel', tone: 'info' });
        }
        // guardians appear at the 2nd and 4th beacon
        const n = this.stats.beacons;
        if (!b.guard && (n === 1 || n === 3) && b.progress > 0.2) {
          b.guard = true;
          const a = this.rng.angle();
          const e = this.spawnEnemy('herald', b.x + Math.cos(a) * 13, b.z + Math.sin(a) * 13);
          this.events.push({ t: 'bossSpawn', x: e.x, z: e.z, kind: 'herald' });
          this.events.push({ t: 'announce', key: 'ann.herald', tone: 'warn' });
        }
        let cap = 1;
        if (b.guard) for (const g of this.bigs) if (g.alive && g.kind === 'herald') cap = 0.9;
        b.progress = Math.min(cap, b.progress + dt / 13);
        if (b.progress >= 1) this.lightBeacon(i);
      } else if (b.progress > 0) {
        b.progress = Math.max(0, b.progress - dt * 0.015);
      }
    }
    if (allLit && !this.boss && !this.stats.bossKilled && this.bossT < 0 && this.endT < 0) {
      this.bossT = 6;
      this.events.push({ t: 'announce', key: 'ann.eclipse', tone: 'warn' });
    }
    if (this.bossT >= 0) {
      this.bossT -= dt;
      if (this.bossT < 0) {
        // arrive in open ground: never on top of a beacon tower
        let pos = this.ringPoint(16, 20, 3, Math.atan2(-p.z, -p.x));
        for (let tries = 0; tries < 10; tries++) {
          let clear = true;
          for (const b of this.beacons) if (Math.hypot(b.x - pos.x, b.z - pos.z) < 13) clear = false;
          if (clear) break;
          pos = this.ringPoint(16, 24, 3);
        }
        this.boss = this.spawnEnemy('eclipse', pos.x, pos.z);
        this.events.push({ t: 'bossSpawn', x: pos.x, z: pos.z, kind: 'eclipse' });
      }
    }
  }

  private lightBeacon(i: number) {
    const b = this.beacons[i];
    const I = this.intensity();
    b.lit = true;
    b.progress = 1;
    b.channeling = false;
    b.litAt = this.time;
    this.stats.beacons++;
    this.stats.cinders += 15;
    this.events.push({ t: 'beaconLit', i, x: b.x, z: b.z, count: this.stats.beacons });
    const list = this.near(b.x, b.z, 18);
    for (let k = 0; k < list.length; k++) {
      const e = list[k];
      this.applyDamage(e, e.boss ? 150 + 30 * I : 160 + 45 * I, null, false, 26, b.x, b.z);
    }
    this.heal(this.player.st.maxHp * 0.3);
    for (const bp of this.eprojs) bp.alive = false;
    const pend = makeRelicPending(this);
    if (pend) this.pending.push(pend);
    if (this.stats.beacons < this.beacons.length) this.events.push({ t: 'announce', key: 'ann.lit', tone: 'good' });
  }

  /** cinders earned so far (shown on results; banked into the save) */
  cinderTotal(): number {
    const base = this.stats.cinders + this.stats.kills / 30 + (this.stats.bossKilled ? 60 : 0);
    return Math.round(base * this.diff.cinder * this.player.st.cinder);
  }
}
