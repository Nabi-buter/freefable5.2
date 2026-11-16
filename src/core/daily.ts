import { CHAR_IDS, type CharId } from '../sim/defs';
import type { BiomeId } from '../sim/worldgen';
import { hashString } from './rng';

export interface DailyInfo {
  /** UTC date, YYYY-MM-DD */
  date: string;
  seed: number;
  char: CharId;
  biome: BiomeId;
}

const BIOMES: BiomeId[] = ['ashwood', 'frostmere', 'emberwaste', 'gloommire'];

/** Everyone gets the same island, lightbearer and region on a given UTC day. */
export function dailyInfo(now = new Date()): DailyInfo {
  const date = now.toISOString().slice(0, 10);
  const seed = hashString('cinderwake-daily-' + date);
  return { date, seed, char: CHAR_IDS[seed % CHAR_IDS.length], biome: BIOMES[(seed >>> 8) % BIOMES.length] };
}

export const DAILY_BONUS = 120;
