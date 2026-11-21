import { CHARS, CHAR_IDS, PACT_IDS, type CharId, type PactId, type SkillId } from '../sim/defs';
import type { BiomeId } from '../sim/worldgen';
import { hashString } from './rng';

export interface DailyInfo {
  /** UTC date, YYYY-MM-DD */
  date: string;
  seed: number;
  char: CharId;
  biome: BiomeId;
  /** the day's ability and burden, the same for everyone */
  skill: SkillId;
  pact: PactId;
}

const BIOMES: BiomeId[] = ['ashwood', 'frostmere', 'emberwaste', 'gloommire'];

/** Everyone gets the same island, lightbearer and region on a given UTC day. */
export function dailyInfo(now = new Date()): DailyInfo {
  const date = now.toISOString().slice(0, 10);
  const seed = hashString('cinderwake-daily-' + date);
  const char = CHAR_IDS[seed % CHAR_IDS.length];
  const skill = (seed >>> 12) % 2 === 0 ? CHARS[char].skill : CHARS[char].alt;
  return { date, seed, char, biome: BIOMES[(seed >>> 8) % BIOMES.length], skill, pact: PACT_IDS[(seed >>> 16) % PACT_IDS.length] };
}

export const DAILY_BONUS = 120;
