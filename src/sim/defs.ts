/** Static game data: enemies, weapons, passives, relics, characters, meta upgrades. Pure data, no logic. */

// ---------------------------------------------------------------- enemies
export type EnemyKind = 'shade' | 'skitter' | 'brute' | 'spitter' | 'wraith' | 'bomber' | 'husk' | 'rime' | 'worm' | 'sporecap' | 'herald' | 'eclipse';
export const ENEMY_KINDS: EnemyKind[] = ['shade', 'skitter', 'brute', 'spitter', 'wraith', 'bomber', 'husk', 'rime', 'worm', 'sporecap', 'herald', 'eclipse'];

export type EnemyAI = 'chase' | 'ranged' | 'charger' | 'bomber' | 'burrow' | 'herald' | 'eclipse';

export interface EnemyDef {
  kind: EnemyKind;
  hp: number;
  speed: number;
  dmg: number;
  radius: number;
  xp: number;
  /** knockback resistance: 1 = normal, larger = heavier */
  mass: number;
  ai: EnemyAI;
  /** threat cost for the spawn director */
  cost: number;
}

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  shade: { kind: 'shade', hp: 10, speed: 3.3, dmg: 7, radius: 0.55, xp: 1, mass: 1, ai: 'chase', cost: 1 },
  skitter: { kind: 'skitter', hp: 5, speed: 5.6, dmg: 4, radius: 0.4, xp: 1, mass: 0.6, ai: 'chase', cost: 0.7 },
  brute: { kind: 'brute', hp: 80, speed: 2.3, dmg: 15, radius: 1.05, xp: 6, mass: 4, ai: 'chase', cost: 5 },
  spitter: { kind: 'spitter', hp: 20, speed: 2.9, dmg: 9, radius: 0.6, xp: 3, mass: 1, ai: 'ranged', cost: 3 },
  wraith: { kind: 'wraith', hp: 32, speed: 3.1, dmg: 13, radius: 0.65, xp: 4, mass: 1.4, ai: 'charger', cost: 3.5 },
  bomber: { kind: 'bomber', hp: 15, speed: 4.4, dmg: 20, radius: 0.55, xp: 3, mass: 0.8, ai: 'bomber', cost: 2.5 },
  husk: { kind: 'husk', hp: 46, speed: 2.7, dmg: 10, radius: 0.8, xp: 4, mass: 2, ai: 'chase', cost: 3.5 },
  // Frostmere only: a walking glacier that bursts into frost when it falls
  rime: { kind: 'rime', hp: 120, speed: 2.0, dmg: 16, radius: 1.05, xp: 7, mass: 5, ai: 'chase', cost: 5.5 },
  // Ember Wastes only: tunnels under the sand, surfaces beneath you and spits fire
  worm: { kind: 'worm', hp: 40, speed: 6.0, dmg: 11, radius: 0.75, xp: 6, mass: 3, ai: 'burrow', cost: 5.5 },
  // Gloommire only: a walking toadstool that puffs out a poison cloud when it gets close
  sporecap: { kind: 'sporecap', hp: 58, speed: 2.5, dmg: 10, radius: 0.8, xp: 5, mass: 2.5, ai: 'chase', cost: 4.5 },
  herald: { kind: 'herald', hp: 1100, speed: 2.9, dmg: 18, radius: 1.7, xp: 60, mass: 30, ai: 'herald', cost: 0 },
  eclipse: { kind: 'eclipse', hp: 22000, speed: 3.0, dmg: 24, radius: 2.6, xp: 0, mass: 1000, ai: 'eclipse', cost: 0 },
};

// ---------------------------------------------------------------- weapons
export type WeaponId = 'ember' | 'wisps' | 'nova' | 'arc' | 'starfall' | 'lance' | 'frost' | 'darts' | 'trail' | 'aura' | 'glaive' | 'sigil' | 'sprite';
export const WEAPON_IDS: WeaponId[] = ['ember', 'wisps', 'nova', 'arc', 'starfall', 'lance', 'frost', 'darts', 'trail', 'aura', 'glaive', 'sigil', 'sprite'];

export interface WStats {
  /** base damage per hit (or per tick) */
  dmg: number;
  /** cooldown in seconds between activations */
  cd: number;
  /** projectiles / orbs / strikes / chains */
  count: number;
  /** enemies a projectile passes through */
  pierce: number;
  /** radius or size */
  area: number;
  /** lifetime in seconds */
  dur: number;
  /** projectile speed */
  speed: number;
}

export interface WeaponDef {
  id: WeaponId;
  /** levels[0] is level 1. The last entry (index 6) is the evolved form. */
  levels: WStats[];
  /** passive required to evolve */
  evo: PassiveId;
  color: number;
}

const L = (dmg: number, cd: number, count: number, pierce: number, area: number, dur: number, speed: number): WStats => ({ dmg, cd, count, pierce, area, dur, speed });

export const MAX_WEAPON_LEVEL = 6;
export const EVOLVED_LEVEL = 7;

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  // aimed fire bolts
  ember: {
    id: 'ember', evo: 'might', color: 0xff8a3c,
    levels: [
      L(12, 0.62, 1, 1, 0.45, 1.3, 27),
      L(15, 0.62, 2, 1, 0.45, 1.3, 27),
      L(15, 0.52, 2, 2, 0.45, 1.3, 29),
      L(20, 0.52, 3, 2, 0.5, 1.3, 29),
      L(24, 0.44, 3, 3, 0.5, 1.3, 31),
      L(28, 0.4, 4, 3, 0.55, 1.3, 31),
      L(40, 0.34, 5, 4, 0.7, 1.4, 33), // Solar Flare: bolts explode
    ],
  },
  // orbiting orbs
  wisps: {
    id: 'wisps', evo: 'reach', color: 0x7de8ff,
    levels: [
      L(11, 0, 3, 0, 3.0, 0, 3.1),
      L(13, 0, 4, 0, 3.0, 0, 3.1),
      L(15, 0, 4, 0, 3.5, 0, 3.2),
      L(17, 0, 5, 0, 3.5, 0, 3.2),
      L(20, 0, 6, 0, 3.9, 0, 3.4),
      L(24, 0, 7, 0, 4.2, 0, 3.6),
      L(32, 0, 9, 0, 5.2, 0, 4.0), // Halo of Suns: burn on touch
    ],
  },
  // periodic radial blast
  nova: {
    id: 'nova', evo: 'haste', color: 0xffb347,
    levels: [
      L(18, 3.4, 1, 0, 5.2, 0, 0),
      L(24, 3.2, 1, 0, 5.8, 0, 0),
      L(30, 3.0, 1, 0, 6.4, 0, 0),
      L(38, 2.8, 1, 0, 7.0, 0, 0),
      L(46, 2.6, 1, 0, 7.6, 0, 0),
      L(56, 2.4, 1, 0, 8.4, 0, 0),
      L(72, 2.0, 2, 0, 10, 0, 0), // Supernova: echo pulse
    ],
  },
  // chain lightning; count = jumps
  arc: {
    id: 'arc', evo: 'focus', color: 0xa9c8ff,
    levels: [
      L(16, 1.7, 3, 0, 7.5, 0, 0),
      L(20, 1.6, 4, 0, 7.5, 0, 0),
      L(24, 1.5, 5, 0, 8, 0, 0),
      L(29, 1.35, 6, 0, 8, 0, 0),
      L(34, 1.2, 7, 0, 8.5, 0, 0),
      L(40, 1.05, 9, 0, 9, 0, 0),
      L(52, 0.8, 14, 0, 10, 0, 0), // Tempest: forks from every hit
    ],
  },
  // little lights that hover by the bearer and dart at whatever comes close
  sprite: {
    id: 'sprite', evo: 'plating', color: 0xffe9a0,
    levels: [
      L(13, 1.1, 2, 0, 1.3, 0, 22),
      L(16, 1.05, 2, 0, 1.4, 0, 22),
      L(19, 1.0, 3, 0, 1.4, 0, 23),
      L(25, 0.92, 3, 0, 1.6, 0, 24),
      L(30, 0.86, 4, 0, 1.7, 0, 25),
      L(36, 0.78, 5, 0, 1.9, 0, 26),
      L(46, 0.6, 7, 0, 2.6, 0, 30), // Wardens of Light: wider strikes, and they swat hostile shots out of the air
    ],
  },
  // runes on the ground that burst when something steps on them
  sigil: {
    id: 'sigil', evo: 'fortune', color: 0xc9a2ff,
    levels: [
      L(46, 2.4, 1, 0, 2.7, 7, 0),
      L(56, 2.3, 2, 0, 2.7, 7, 0),
      L(66, 2.2, 2, 0, 3.1, 8, 0),
      L(78, 2.0, 3, 0, 3.1, 8, 0),
      L(86, 1.9, 3, 0, 3.5, 9, 0),
      L(96, 1.7, 4, 0, 3.7, 9, 0),
      L(120, 1.4, 5, 0, 4.4, 10, 0), // Seal of Fate: every rune bursts twice
    ],
  },
  // meteors on random enemies
  starfall: {
    id: 'starfall', evo: 'multishot', color: 0xffe08a,
    levels: [
      L(34, 2.6, 1, 0, 2.6, 0, 0),
      L(42, 2.5, 2, 0, 2.6, 0, 0),
      L(50, 2.4, 2, 0, 3.0, 0, 0),
      L(58, 2.2, 3, 0, 3.0, 0, 0),
      L(68, 2.0, 3, 0, 3.4, 0, 0),
      L(80, 1.8, 4, 0, 3.6, 0, 0),
      L(110, 1.5, 6, 0, 4.4, 2.5, 0), // Cataclysm: craters keep burning
    ],
  },
  // piercing beam along aim
  lance: {
    id: 'lance', evo: 'velocity', color: 0xfff1b8,
    levels: [
      L(28, 2.2, 1, 99, 0.9, 0, 0),
      L(36, 2.1, 1, 99, 1.0, 0, 0),
      L(44, 1.95, 1, 99, 1.1, 0, 0),
      L(54, 1.8, 1, 99, 1.25, 0, 0),
      L(64, 1.65, 1, 99, 1.4, 0, 0),
      L(78, 1.5, 1, 99, 1.6, 0, 0),
      L(100, 1.2, 2, 99, 2.1, 0, 0), // Dawnbreaker: fires forward and back
    ],
  },
  // short-range chilling shards in a cone
  frost: {
    id: 'frost', evo: 'wisdom', color: 0x9fe3ff,
    levels: [
      L(8, 1.15, 4, 1, 0.38, 0.5, 22),
      L(10, 1.1, 5, 1, 0.38, 0.52, 22),
      L(12, 1.05, 6, 2, 0.4, 0.54, 23),
      L(14, 0.98, 7, 2, 0.4, 0.56, 23),
      L(17, 0.9, 8, 2, 0.42, 0.6, 24),
      L(20, 0.82, 9, 3, 0.45, 0.64, 24),
      L(26, 0.7, 16, 3, 0.5, 0.7, 25), // Glacial Storm: full circle, freezes
    ],
  },
  // homing missiles
  darts: {
    id: 'darts', evo: 'swift', color: 0xc6a2ff,
    levels: [
      L(14, 1.5, 2, 0, 0.4, 2.6, 17),
      L(17, 1.45, 2, 0, 0.4, 2.6, 18),
      L(19, 1.35, 3, 0, 0.4, 2.6, 19),
      L(23, 1.25, 3, 0, 0.4, 2.6, 20),
      L(26, 1.15, 4, 0, 0.4, 2.6, 21),
      L(31, 1.05, 5, 0, 0.45, 2.6, 22),
      L(38, 0.85, 7, 2, 0.5, 3.0, 25), // Phantom Swarm: darts pierce
    ],
  },
  // fire left behind while moving
  trail: {
    id: 'trail', evo: 'mending', color: 0xff6a2a,
    levels: [
      L(9, 0.34, 1, 0, 1.5, 2.6, 0),
      L(12, 0.34, 1, 0, 1.6, 2.9, 0),
      L(15, 0.3, 1, 0, 1.75, 3.2, 0),
      L(19, 0.3, 1, 0, 1.9, 3.5, 0),
      L(23, 0.27, 1, 0, 2.05, 3.8, 0),
      L(28, 0.25, 1, 0, 2.2, 4.2, 0),
      L(38, 0.22, 1, 0, 2.8, 5.0, 0), // Wildfire: patches burst when they expire
    ],
  },
  // damaging aura around the player
  aura: {
    id: 'aura', evo: 'vigor', color: 0xffd98a,
    levels: [
      L(5, 0.5, 1, 0, 3.6, 0, 0),
      L(6.5, 0.5, 1, 0, 4.0, 0, 0),
      L(8, 0.46, 1, 0, 4.4, 0, 0),
      L(10, 0.46, 1, 0, 4.8, 0, 0),
      L(12, 0.42, 1, 0, 5.2, 0, 0),
      L(15, 0.4, 1, 0, 5.7, 0, 0),
      L(21, 0.36, 1, 0, 7.0, 0, 0), // Sanctum: heals the bearer, slows foes
    ],
  },
  // boomerang blade
  glaive: {
    id: 'glaive', evo: 'magnet', color: 0xd9e4ff,
    levels: [
      L(16, 2.0, 1, 99, 0.9, 1.5, 21),
      L(20, 1.9, 1, 99, 1.0, 1.5, 22),
      L(24, 1.8, 2, 99, 1.0, 1.5, 23),
      L(29, 1.7, 2, 99, 1.15, 1.6, 24),
      L(34, 1.55, 3, 99, 1.2, 1.6, 25),
      L(40, 1.4, 3, 99, 1.35, 1.7, 26),
      L(52, 1.1, 4, 99, 1.7, 1.8, 28), // Eclipse Glaive: pulls embers, huge
    ],
  },
};

// ---------------------------------------------------------------- passives
export type PassiveId = 'vigor' | 'mending' | 'plating' | 'swift' | 'might' | 'haste' | 'reach' | 'multishot' | 'focus' | 'magnet' | 'wisdom' | 'velocity' | 'fortune';
export const PASSIVE_IDS: PassiveId[] = ['vigor', 'mending', 'plating', 'swift', 'might', 'haste', 'reach', 'multishot', 'focus', 'magnet', 'wisdom', 'velocity', 'fortune'];

export interface PassiveDef {
  id: PassiveId;
  max: number;
  /** value per level, used for description text */
  per: number;
  color: number;
}

export const PASSIVES: Record<PassiveId, PassiveDef> = {
  vigor: { id: 'vigor', max: 5, per: 20, color: 0xff5d6c },
  mending: { id: 'mending', max: 5, per: 0.5, color: 0x7dff9b },
  plating: { id: 'plating', max: 5, per: 1, color: 0xb9c4d6 },
  swift: { id: 'swift', max: 5, per: 7, color: 0x8affea },
  might: { id: 'might', max: 5, per: 10, color: 0xff9a4a },
  haste: { id: 'haste', max: 5, per: 7, color: 0xffe36b },
  reach: { id: 'reach', max: 5, per: 10, color: 0x9fb4ff },
  multishot: { id: 'multishot', max: 2, per: 1, color: 0xffb8f0 },
  focus: { id: 'focus', max: 5, per: 8, color: 0xff6bd0 },
  magnet: { id: 'magnet', max: 5, per: 30, color: 0x6bd1ff },
  wisdom: { id: 'wisdom', max: 5, per: 9, color: 0xc7a2ff },
  velocity: { id: 'velocity', max: 5, per: 12, color: 0xb2ff7d },
  fortune: { id: 'fortune', max: 5, per: 12, color: 0xffd24a },
};

export const MAX_WEAPONS = 5;
export const MAX_PASSIVES = 5;

// ---------------------------------------------------------------- relics
export type RelicId =
  | 'phoenix' | 'twinflame' | 'bloodember' | 'stormheart' | 'glasslantern' | 'secondwind' | 'emberbloom' | 'frozencore'
  | 'gildedwick' | 'wideglow' | 'quickening' | 'beaconbond' | 'titanash' | 'huntersmark' | 'afterimage' | 'starmoss' | 'riteember' | 'afterglow';
export const RELIC_IDS: RelicId[] = [
  'phoenix', 'twinflame', 'bloodember', 'stormheart', 'glasslantern', 'secondwind', 'emberbloom', 'frozencore',
  'gildedwick', 'wideglow', 'quickening', 'beaconbond', 'titanash', 'huntersmark', 'afterimage', 'starmoss', 'riteember', 'afterglow',
];
export const RELIC_COLORS: Record<RelicId, number> = {
  phoenix: 0xff7a3c, twinflame: 0xffb8f0, bloodember: 0xff4d5e, stormheart: 0xa9c8ff, glasslantern: 0xe8f6ff,
  secondwind: 0x8affea, emberbloom: 0xff9a4a, frozencore: 0x9fe3ff, gildedwick: 0xffd24a, wideglow: 0x9fb4ff,
  quickening: 0xffe36b, beaconbond: 0xffc56b, titanash: 0xb9c4d6, huntersmark: 0xff6bd0, afterimage: 0xc6a2ff, starmoss: 0x7dff9b,
  riteember: 0xffa86b, afterglow: 0xfff0a0,
};

// ---------------------------------------------------------------- characters
export type CharId = 'kindler' | 'stormcaller' | 'warden' | 'frostweaver' | 'ashwalker';
export const CHAR_IDS: CharId[] = ['kindler', 'stormcaller', 'warden', 'frostweaver', 'ashwalker'];

export interface CharDef {
  id: CharId;
  weapon: WeaponId;
  hp: number;
  speed: number;
  armor: number;
  might: number;
  haste: number;
  area: number;
  xp: number;
  dashCharges: number;
  /** signature ability */
  skill: SkillId;
  /** cloak colour / accent colour for the renderer */
  cloak: number;
  accent: number;
}

// ---------------------------------------------------------------- signature abilities
export type SkillId = 'flare' | 'tempest' | 'bulwark' | 'deepfreeze' | 'cinderstep';
export interface SkillDef {
  id: SkillId;
  /** cooldown, seconds */
  cd: number;
  color: number;
}
export const SKILLS: Record<SkillId, SkillDef> = {
  flare: { id: 'flare', cd: 20, color: 0xffa040 },
  tempest: { id: 'tempest', cd: 18, color: 0x9fc4ff },
  bulwark: { id: 'bulwark', cd: 26, color: 0x7de8ff },
  deepfreeze: { id: 'deepfreeze', cd: 24, color: 0xbdf0ff },
  cinderstep: { id: 'cinderstep', cd: 18, color: 0xff5a2a },
};

export const CHARS: Record<CharId, CharDef> = {
  kindler: { id: 'kindler', weapon: 'ember', hp: 100, speed: 7.2, armor: 0, might: 1, haste: 1, area: 1, xp: 1.1, dashCharges: 1, skill: 'flare', cloak: 0x7a3524, accent: 0xffa040 },
  stormcaller: { id: 'stormcaller', weapon: 'arc', hp: 80, speed: 7.9, armor: 0, might: 1, haste: 1.12, area: 1, xp: 1, dashCharges: 1, skill: 'tempest', cloak: 0x2a3f7a, accent: 0x9fc4ff },
  warden: { id: 'warden', weapon: 'wisps', hp: 140, speed: 6.6, armor: 2, might: 1, haste: 1, area: 1, xp: 1, dashCharges: 1, skill: 'bulwark', cloak: 0x2f5a44, accent: 0x7de8ff },
  frostweaver: { id: 'frostweaver', weapon: 'frost', hp: 90, speed: 7.2, armor: 0, might: 1, haste: 1, area: 1.18, xp: 1, dashCharges: 1, skill: 'deepfreeze', cloak: 0x3b5d7c, accent: 0xbdf0ff },
  ashwalker: { id: 'ashwalker', weapon: 'trail', hp: 95, speed: 7.7, armor: 0, might: 1.1, haste: 1, area: 1, xp: 1, dashCharges: 2, skill: 'cinderstep', cloak: 0x3a2d33, accent: 0xff5a2a },
};

// ---------------------------------------------------------------- difficulty
export interface DifficultyDef {
  id: number;
  hp: number;
  dmg: number;
  spawn: number;
  cinder: number;
}
export const DIFFICULTIES: DifficultyDef[] = [
  { id: 0, hp: 1, dmg: 1, spawn: 1, cinder: 1 },
  { id: 1, hp: 1.55, dmg: 1.35, spawn: 1.22, cinder: 1.6 },
  { id: 2, hp: 2.7, dmg: 2.0, spawn: 1.6, cinder: 2.4 },
];

// ---------------------------------------------------------------- meta upgrades (bought with cinders between runs)
export type MetaId = 'm_hp' | 'm_might' | 'm_haste' | 'm_speed' | 'm_regen' | 'm_armor' | 'm_magnet' | 'm_xp' | 'm_cinder' | 'm_revive' | 'm_reroll' | 'm_banish' | 'm_luck' | 'm_skill';
export interface MetaDef {
  id: MetaId;
  max: number;
  baseCost: number;
  costMul: number;
  per: number;
}
export const META: MetaDef[] = [
  { id: 'm_hp', max: 5, baseCost: 40, costMul: 1.7, per: 6 },
  { id: 'm_might', max: 5, baseCost: 60, costMul: 1.75, per: 4 },
  { id: 'm_haste', max: 5, baseCost: 60, costMul: 1.75, per: 3 },
  { id: 'm_speed', max: 5, baseCost: 40, costMul: 1.7, per: 2 },
  { id: 'm_regen', max: 5, baseCost: 50, costMul: 1.7, per: 0.15 },
  { id: 'm_armor', max: 3, baseCost: 120, costMul: 2.2, per: 1 },
  { id: 'm_magnet', max: 5, baseCost: 30, costMul: 1.6, per: 12 },
  { id: 'm_xp', max: 5, baseCost: 50, costMul: 1.7, per: 4 },
  { id: 'm_cinder', max: 5, baseCost: 70, costMul: 1.8, per: 10 },
  { id: 'm_luck', max: 5, baseCost: 50, costMul: 1.7, per: 8 },
  { id: 'm_skill', max: 5, baseCost: 70, costMul: 1.7, per: 6 },
  { id: 'm_reroll', max: 4, baseCost: 80, costMul: 2.0, per: 1 },
  { id: 'm_banish', max: 4, baseCost: 80, costMul: 2.0, per: 1 },
  { id: 'm_revive', max: 1, baseCost: 600, costMul: 1, per: 1 },
];
export const metaCost = (m: MetaDef, level: number) => Math.round((m.baseCost * Math.pow(m.costMul, level)) / 5) * 5;
