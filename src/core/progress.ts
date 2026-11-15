import { CHAR_IDS, EVOLVED_LEVEL, type CharId } from '../sim/defs';
import type { Sim } from '../sim/sim';
import type { BiomeId } from '../sim/worldgen';
import type { SaveData } from './save';

export interface AchDef {
  id: string;
  reward: number;
}

export const ACHIEVEMENTS: AchDef[] = [
  { id: 'first_light', reward: 20 },
  { id: 'dawn', reward: 100 },
  { id: 'midnight', reward: 200 },
  { id: 'eclipse', reward: 400 },
  { id: 'kills1', reward: 30 },
  { id: 'kills2', reward: 120 },
  { id: 'kills3', reward: 300 },
  { id: 'level30', reward: 60 },
  { id: 'evolve', reward: 50 },
  { id: 'evolve3', reward: 150 },
  { id: 'combo', reward: 60 },
  { id: 'swift', reward: 150 },
  { id: 'untouched', reward: 200 },
  { id: 'elites', reward: 80 },
  { id: 'beacons25', reward: 80 },
  { id: 'relics', reward: 60 },
  { id: 'rich', reward: 150 },
  { id: 'allchars', reward: 150 },
  { id: 'winall', reward: 400 },
  { id: 'allbiomes', reward: 250 },
];

export interface RunSummary {
  win: boolean;
  time: number;
  level: number;
  kills: number;
  beacons: number;
  maxCombo: number;
  dmgDealt: number;
  cinders: number;
  /** cinders from achievements, on top of `cinders` */
  bonus: number;
  weapons: { id: string; level: number; dealt: number }[];
  unlockedChars: CharId[];
  unlockedBiomes: BiomeId[];
  unlockedDiff: number;
  achievements: string[];
  newBest: boolean;
}

/** Bank a finished (or abandoned) run into the save and report what changed. */
export function finishRun(save: SaveData, sim: Sim): RunSummary {
  const st = save.stats;
  const p = sim.player;
  const win = sim.state === 'victory';
  const diff = sim.diff.id;
  const char = sim.cfg.char;
  const biome = sim.cfg.biome;
  const cinders = sim.cinderTotal();
  const evolved = p.weapons.filter((w) => w.level >= EVOLVED_LEVEL).length;

  st.runs++;
  st.kills += sim.stats.kills;
  st.eliteKills += sim.stats.eliteKills;
  st.beacons += sim.stats.beacons;
  st.time += sim.time;
  st.maxLevel = Math.max(st.maxLevel, p.level);
  st.maxCombo = Math.max(st.maxCombo, sim.stats.maxCombo);
  st.cindersEarned += cinders;
  st.evolutions += evolved;
  let newBest = false;
  let unlockedDiff = -1;
  if (win) {
    st.wins++;
    st.winsByChar[char] = (st.winsByChar[char] ?? 0) + 1;
    st.winsByBiome[biome] = (st.winsByBiome[biome] ?? 0) + 1;
    if (!st.bestTime[diff] || sim.time < st.bestTime[diff]) {
      newBest = st.bestTime[diff] > 0;
      st.bestTime[diff] = sim.time;
    }
    if (st.cleared < diff + 1) {
      st.cleared = diff + 1;
      if (diff + 1 <= 2) unlockedDiff = diff + 1;
    }
  }
  save.cinders += cinders;

  // ---- unlocks
  const unlockedChars: CharId[] = [];
  const giveChar = (c: CharId, cond: boolean) => {
    if (cond && !save.chars.includes(c)) {
      save.chars.push(c);
      unlockedChars.push(c);
    }
  };
  giveChar('stormcaller', sim.stats.beacons >= 3);
  giveChar('warden', p.level >= 20);
  giveChar('frostweaver', win);
  giveChar('ashwalker', win && diff >= 1);
  const unlockedBiomes: BiomeId[] = [];
  const giveBiome = (b: BiomeId, cond: boolean) => {
    if (cond && !save.biomes.includes(b)) {
      save.biomes.push(b);
      unlockedBiomes.push(b);
    }
  };
  giveBiome('frostmere', win && biome === 'ashwood');
  giveBiome('emberwaste', win && biome === 'frostmere');

  // ---- achievements
  const got: string[] = [];
  let bonus = 0;
  const ach = (id: string, cond: boolean) => {
    if (!cond || save.achievements[id]) return;
    save.achievements[id] = Date.now();
    got.push(id);
    const def = ACHIEVEMENTS.find((a) => a.id === id);
    if (def) bonus += def.reward;
  };
  ach('first_light', sim.stats.beacons >= 1);
  ach('dawn', win);
  ach('midnight', win && diff >= 1);
  ach('eclipse', win && diff >= 2);
  ach('kills1', st.kills >= 1000);
  ach('kills2', st.kills >= 10000);
  ach('kills3', st.kills >= 50000);
  ach('level30', p.level >= 30);
  ach('evolve', evolved >= 1);
  ach('evolve3', evolved >= 3);
  ach('combo', sim.stats.maxCombo >= 300);
  ach('swift', win && sim.time < 12 * 60);
  ach('untouched', win && sim.stats.dmgTaken <= 150);
  ach('elites', st.eliteKills >= 50);
  ach('beacons25', st.beacons >= 25);
  ach('relics', p.relics.length >= 5);
  ach('rich', st.cindersEarned >= 5000);
  ach('allchars', CHAR_IDS.every((c) => save.chars.includes(c)));
  ach('winall', CHAR_IDS.every((c) => (st.winsByChar[c] ?? 0) > 0));
  ach('allbiomes', (['ashwood', 'frostmere', 'emberwaste'] as BiomeId[]).every((b) => (st.winsByBiome[b] ?? 0) > 0));
  save.cinders += bonus;

  return {
    win, time: sim.time, level: p.level, kills: sim.stats.kills, beacons: sim.stats.beacons, maxCombo: sim.stats.maxCombo,
    dmgDealt: sim.stats.dmgDealt, cinders, bonus,
    weapons: p.weapons.map((w) => ({ id: w.id, level: w.level, dealt: w.dealt })).sort((a, b) => b.dealt - a.dealt),
    unlockedChars, unlockedBiomes, unlockedDiff, achievements: got, newBest,
  };
}
