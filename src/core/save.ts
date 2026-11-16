import { CHAR_IDS, META, type CharId, type MetaId } from '../sim/defs';
import type { BiomeId } from '../sim/worldgen';

export type Lang = 'ko' | 'en';
export type QualitySetting = 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  lang: Lang;
  quality: QualitySetting;
  master: number;
  music: number;
  sfx: number;
  shake: number;
  damageNumbers: boolean;
  autoAim: boolean;
  zoom: number;
  showFps: boolean;
  /** lower the quality automatically when the frame rate stays low */
  autoQuality: boolean;
}

export interface LifetimeStats {
  runs: number;
  wins: number;
  kills: number;
  eliteKills: number;
  beacons: number;
  time: number;
  maxLevel: number;
  maxCombo: number;
  cindersEarned: number;
  evolutions: number;
  /** best win time per difficulty, seconds (0 = none) */
  bestTime: number[];
  winsByChar: Partial<Record<CharId, number>>;
  winsByBiome: Partial<Record<BiomeId, number>>;
  /** highest difficulty beaten + 1 */
  cleared: number;
}

export interface SaveData {
  v: number;
  cinders: number;
  meta: Partial<Record<MetaId, number>>;
  chars: CharId[];
  biomes: BiomeId[];
  achievements: Record<string, number>;
  stats: LifetimeStats;
  settings: Settings;
  last: { char: CharId; biome: BiomeId; difficulty: number };
  tutorial: boolean;
}

const KEY = 'cinderwake.save.v1';

function defaultLang(): Lang {
  try {
    return (navigator.language || 'en').toLowerCase().startsWith('ko') ? 'ko' : 'en';
  } catch {
    return 'en';
  }
}

export function defaultSave(): SaveData {
  return {
    v: 1,
    cinders: 0,
    meta: {},
    chars: ['kindler'],
    biomes: ['ashwood'],
    achievements: {},
    stats: {
      runs: 0, wins: 0, kills: 0, eliteKills: 0, beacons: 0, time: 0, maxLevel: 0, maxCombo: 0, cindersEarned: 0, evolutions: 0,
      bestTime: [0, 0, 0], winsByChar: {}, winsByBiome: {}, cleared: 0,
    },
    settings: { lang: defaultLang(), quality: 'high', master: 0.8, music: 0.6, sfx: 0.8, shake: 1, damageNumbers: true, autoAim: false, zoom: 1, showFps: false, autoQuality: true },
    last: { char: 'kindler', biome: 'ashwood', difficulty: 0 },
    tutorial: false,
  };
}

/** merge loaded data over defaults so new fields survive old saves */
function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return (over === undefined ? base : (over as T));
  const out = { ...(base as object) } as Record<string, unknown>;
  for (const k of Object.keys(over as object)) {
    const b = (base as Record<string, unknown>)[k];
    const o = (over as Record<string, unknown>)[k];
    out[k] = b !== null && typeof b === 'object' && !Array.isArray(b) ? merge(b, o) : o;
  }
  return out as T;
}

export class SaveStore {
  data: SaveData;
  private mem = false;

  constructor() {
    this.data = defaultSave();
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.data = merge(defaultSave(), JSON.parse(raw));
    } catch {
      this.mem = true;
    }
    this.sanitize();
  }

  private sanitize() {
    const d = this.data;
    if (!Array.isArray(d.chars) || d.chars.length === 0) d.chars = ['kindler'];
    d.chars = d.chars.filter((c) => CHAR_IDS.includes(c));
    if (!d.chars.includes('kindler')) d.chars.unshift('kindler');
    if (!Array.isArray(d.biomes) || !d.biomes.includes('ashwood')) d.biomes = ['ashwood', ...(Array.isArray(d.biomes) ? d.biomes : [])];
    d.cinders = Math.max(0, Math.floor(Number(d.cinders) || 0));
    for (const m of META) {
      const v = d.meta[m.id] ?? 0;
      d.meta[m.id] = Math.max(0, Math.min(m.max, Math.floor(Number(v) || 0)));
    }
    if (!d.chars.includes(d.last.char)) d.last.char = 'kindler';
    if (!d.biomes.includes(d.last.biome)) d.last.biome = 'ashwood';
    d.last.difficulty = Math.max(0, Math.min(d.stats.cleared, 2, Math.floor(d.last.difficulty) || 0));
    const s = d.settings;
    const c01 = (v: number, def: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : def);
    s.master = c01(s.master, 0.8);
    s.music = c01(s.music, 0.6);
    s.sfx = c01(s.sfx, 0.8);
    s.shake = Number.isFinite(s.shake) ? Math.max(0, Math.min(1.5, s.shake)) : 1;
    s.zoom = Number.isFinite(s.zoom) ? Math.max(0.75, Math.min(1.3, s.zoom)) : 1;
    if (s.lang !== 'ko' && s.lang !== 'en') s.lang = defaultLang();
    if (!['low', 'medium', 'high', 'ultra'].includes(s.quality)) s.quality = 'high';
  }

  save() {
    if (this.mem) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      this.mem = true;
    }
  }

  reset() {
    const settings = this.data.settings;
    this.data = defaultSave();
    this.data.settings = settings;
    this.save();
  }

  export(): string {
    return btoa(unescape(encodeURIComponent(JSON.stringify(this.data))));
  }

  import(code: string): boolean {
    try {
      const obj = JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
      if (!obj || typeof obj !== 'object' || typeof obj.v !== 'number') return false;
      this.data = merge(defaultSave(), obj);
      this.sanitize();
      this.save();
      return true;
    } catch {
      return false;
    }
  }
}
