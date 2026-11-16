import type { EnemyDef, EnemyKind, PassiveId, RelicId, SkillId, WeaponId } from './defs';

export interface InputState {
  /** desired movement, length <= 1 */
  mx: number;
  mz: number;
  /** aim direction (unit) in world space; ignored when autoAim */
  aimX: number;
  aimZ: number;
  autoAim: boolean;
  /** edge-triggered dash request */
  dash: boolean;
  /** edge-triggered signature ability request */
  skill?: boolean;
}

export interface Stats {
  maxHp: number;
  regen: number;
  armor: number;
  speed: number;
  might: number;
  haste: number;
  area: number;
  projSpeed: number;
  dur: number;
  amount: number;
  crit: number;
  critMul: number;
  pickup: number;
  xp: number;
  luck: number;
  cinder: number;
  dashMax: number;
  dashCd: number;
}

export interface WeaponInst {
  id: WeaponId;
  level: number;
  /** cooldown timer */
  t: number;
  /** generic state: orbit angle, echo timer... */
  a: number;
  b: number;
  /** total damage dealt this run (for the results screen) */
  dealt: number;
}

export interface PassiveInst {
  id: PassiveId;
  level: number;
}

export interface Player {
  x: number;
  z: number;
  vx: number;
  vz: number;
  facing: number;
  aim: number;
  hp: number;
  level: number;
  xp: number;
  xpNext: number;
  iframe: number;
  dashT: number;
  dashCdT: number;
  dashCharges: number;
  /** seconds of movement slow remaining (frost bursts) */
  slowT: number;
  dashX: number;
  dashZ: number;
  moving: boolean;
  hurtT: number;
  revives: number;
  /** signature ability: cooldown left, active time left, scratch accumulator */
  skillCd: number;
  skillT: number;
  skillAcc: number;
  weapons: WeaponInst[];
  passives: PassiveInst[];
  relics: RelicId[];
  st: Stats;
  rerolls: number;
  banishes: number;
  alive: boolean;
}

export interface Enemy {
  id: number;
  kind: EnemyKind;
  def: EnemyDef;
  x: number;
  z: number;
  /** knockback velocity */
  kx: number;
  kz: number;
  hp: number;
  maxHp: number;
  r: number;
  speed: number;
  dmg: number;
  alive: boolean;
  elite: boolean;
  boss: boolean;
  /** hit flash 0..1 */
  flash: number;
  burnT: number;
  burnDps: number;
  burnAcc: number;
  chillT: number;
  freezeT: number;
  /** age */
  t: number;
  /** AI state + timer + scratch */
  st: number;
  stT: number;
  ax: number;
  az: number;
  n: number;
  face: number;
  /** contact cooldowns for orbit / re-hit style weapons */
  cdA: number;
  cdB: number;
  /** per-enemy random 0..1 (wander phase, visual variety) */
  seed: number;
  /** spawn-in animation timer (counts up to 1) */
  spawn: number;
  scale: number;
  /** visual hint: 0 none, 1 winding up attack */
  tele: number;
  /** underground and untouchable (burrowing enemies) */
  buried: boolean;
  /** elite affix: 0 none, 1 swift, 2 regenerating, 3 volatile, 4 splitting, 5 armoured */
  affix: number;
  /** boss scratch: phase, move counter, locked charge direction + length */
  phase: number;
  c1: number;
  lx: number;
  lz: number;
  ll: number;
}

export type ProjKind = 'ember' | 'frost' | 'dart' | 'glaive';

export interface Proj {
  id: number;
  kind: ProjKind;
  weapon: WeaponId;
  x: number;
  z: number;
  vx: number;
  vz: number;
  life: number;
  maxLife: number;
  r: number;
  dmg: number;
  pierce: number;
  hits: number[];
  target: Enemy | null;
  evolved: boolean;
  /** glaive: 0 outbound, 1 returning. dart: retarget counter */
  phase: number;
  spin: number;
  alive: boolean;
}

export interface EProj {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  life: number;
  r: number;
  dmg: number;
  kind: number; // 0 spit, 1 boss orb, 2 fireball
  alive: boolean;
}

export type ZoneKind = 'fire' | 'meteor' | 'slam' | 'crater' | 'charge' | 'vent' | 'frost';

export interface Zone {
  id: number;
  kind: ZoneKind;
  x: number;
  z: number;
  r: number;
  /** elapsed */
  t: number;
  /** fire: lifetime. meteor/slam: delay until impact */
  dur: number;
  dmg: number;
  tick: number;
  hostile: boolean;
  weapon: WeaponId | null;
  evolved: boolean;
  /** charge telegraph: direction + length */
  dx: number;
  dz: number;
  len: number;
  alive: boolean;
}

export type PickupKind = 'xp' | 'heal' | 'magnet' | 'chest' | 'cinder';

export interface Pickup {
  id: number;
  kind: PickupKind;
  x: number;
  z: number;
  v: number;
  pull: boolean;
  t: number;
  vx: number;
  vz: number;
  alive: boolean;
}

export interface Beacon {
  x: number;
  z: number;
  progress: number;
  lit: boolean;
  channeling: boolean;
  pulseT: number;
  guard: boolean;
  litAt: number;
}

export type Choice =
  | { type: 'weapon'; id: WeaponId; level: number; isNew: boolean }
  | { type: 'evolve'; id: WeaponId }
  | { type: 'passive'; id: PassiveId; level: number; isNew: boolean }
  | { type: 'relic'; id: RelicId }
  | { type: 'heal' }
  | { type: 'cinder' };

export interface Pending {
  type: 'levelup' | 'relic' | 'chest';
  choices: Choice[];
  /** chest: rewards are applied automatically, list is for presentation */
  cinders?: number;
}

export type SimEvent =
  | { t: 'shoot'; w: WeaponId; x: number; z: number }
  | { t: 'hit'; x: number; z: number; dmg: number; crit: boolean; w: WeaponId | null; kill: boolean; big: boolean }
  | { t: 'kill'; x: number; z: number; kind: EnemyKind; elite: boolean; r: number; face: number; /** 0 = no body left behind (blew itself up) */ scale: number }
  | { t: 'explode'; x: number; z: number; r: number; c: number; hostile: boolean }
  | { t: 'lightning'; pts: number[] }
  | { t: 'beam'; x: number; z: number; dx: number; dz: number; len: number; w: number }
  | { t: 'nova'; x: number; z: number; r: number; c: number }
  | { t: 'pickup'; kind: PickupKind; v: number; x: number; z: number }
  | { t: 'levelup'; level: number }
  | { t: 'hurt'; dmg: number; x: number; z: number }
  | { t: 'heal'; v: number }
  | { t: 'dash'; x: number; z: number }
  | { t: 'beaconStart'; i: number }
  | { t: 'beaconLit'; i: number; x: number; z: number; count: number }
  | { t: 'beaconPulse'; i: number; x: number; z: number; r: number }
  | { t: 'bossSpawn'; x: number; z: number; kind: EnemyKind }
  | { t: 'bossDie'; x: number; z: number; kind: EnemyKind }
  | { t: 'bossPhase'; phase: number }
  | { t: 'announce'; key: string; tone: 'info' | 'warn' | 'good' }
  | { t: 'spit'; x: number; z: number }
  | { t: 'charge'; x: number; z: number }
  | { t: 'revive'; x: number; z: number }
  | { t: 'death'; x: number; z: number }
  | { t: 'victory' }
  | { t: 'loop'; n: number }
  | { t: 'skill'; id: SkillId; x: number; z: number; r: number }
  | { t: 'skillReady' }
  | { t: 'spawnElite'; x: number; z: number }
  | { t: 'freeze'; x: number; z: number };

export interface RunStats {
  kills: number;
  eliteKills: number;
  dmgDealt: number;
  dmgTaken: number;
  cinders: number;
  beacons: number;
  bossKilled: boolean;
  /** endless mode: how many times the Eclipse has been defeated */
  loops: number;
  maxCombo: number;
  healed: number;
}
