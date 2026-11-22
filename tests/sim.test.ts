import { defaultSave } from '../src/core/save';
import { finishRun } from '../src/core/progress';
import { CHARS } from '../src/sim/defs';
import { describe, expect, it } from 'vitest';
import { runBot } from './simbot';
import { World } from '../src/sim/worldgen';
import { Sim } from '../src/sim/sim';
import { choose } from '../src/sim/choices';

describe('world generation', () => {
  it('is deterministic for a seed', () => {
    const a = new World(1234, 'ashwood');
    const b = new World(1234, 'ashwood');
    expect(a.obstacles.length).toBe(b.obstacles.length);
    expect(a.beacons).toEqual(b.beacons);
    expect(a.height(10, -20)).toBe(b.height(10, -20));
  });
  it('keeps the start clearing and beacons free of obstacles', () => {
    const w = new World(99, 'ashwood');
    expect(w.blocked(0, 2.5, 0.5)).toBe(false);
    for (const b of w.beacons) expect(w.blocked(b.x + 3, b.z, 0.5)).toBe(false);
  });
});

describe('simulation', () => {
  it('plays a run without errors and makes progress', () => {
    const r = runBot(4242, 0, 'kindler', 0.7, 240);
    expect(r.kills).toBeGreaterThan(50);
    expect(r.level).toBeGreaterThan(3);
    expect(Number.isFinite(r.time)).toBe(true);
  }, 60000);
  it('runs every region with its hazards', () => {
    for (const b of ['frostmere', 'emberwaste', 'gloommire', 'stormcrag'] as const) {
      const r = runBot(31, 0, 'kindler', 0.7, 120, false, b);
      expect(r.kills).toBeGreaterThan(20);
    }
  }, 60000);
  it('endless mode relights the island after the Eclipse falls', () => {
    const sim = new Sim({ seed: 5, char: 'kindler', difficulty: 0, biome: 'ashwood', meta: {}, endless: true });
    const input = { mx: 0, mz: 0, aimX: 1, aimZ: 0, autoAim: true, dash: false };
    const hack = sim as unknown as { lightBeacon(i: number): void };
    for (let i = 0; i < sim.beacons.length; i++) hack.lightBeacon(i);
    const drain = () => {
      while (sim.pending.length) choose(sim, 0);
    };
    drain();
    for (let i = 0; i < 60 * 8 && !sim.boss; i++) {
      sim.player.hp = sim.player.st.maxHp;
      sim.step(1 / 60, input);
      drain();
    }
    expect(sim.boss).not.toBeNull();
    sim.boss!.hp = 1;
    sim.kill(sim.boss!);
    for (let i = 0; i < 60 * 7; i++) {
      sim.player.hp = sim.player.st.maxHp;
      sim.step(1 / 60, input);
      drain();
    }
    expect(sim.state).toBe('playing');
    expect(sim.stats.loops).toBe(1);
    expect(sim.stats.bossKilled).toBe(false);
    expect(sim.beacons.every((b) => !b.lit)).toBe(true);
  }, 60000);
  it('keeps spatial query results intact across nested queries', () => {
    const sim = new Sim({ seed: 9, char: 'kindler', difficulty: 0, biome: 'ashwood', meta: {} });
    const input = { mx: 0, mz: 0, aimX: 1, aimZ: 0, autoAim: true, dash: false };
    for (let i = 0; i < 60 * 20; i++) {
      sim.player.hp = sim.player.st.maxHp;
      sim.step(1 / 60, input);
      while (sim.pending.length) choose(sim, 0);
    }
    const first = sim.near(sim.player.x, sim.player.z, 60);
    const snapshot = first.slice();
    expect(snapshot.length).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) sim.near(sim.player.x + 500, sim.player.z, 1);
    expect(first).toEqual(snapshot);
  }, 60000);
  it('every signature ability fires, goes on cooldown and comes back', () => {
    for (const c of ['kindler', 'stormcaller', 'warden', 'frostweaver', 'ashwalker', 'stargazer', 'tinker', 'moonknight'] as const) for (const alt of [false, true]) {
      const sim = new Sim({ seed: 21, char: c, difficulty: 0, biome: 'ashwood', meta: {}, skill: alt ? CHARS[c].alt : undefined });
      expect(sim.skill).toBe(alt ? CHARS[c].alt : CHARS[c].skill);
      const input = { mx: 1, mz: 0, aimX: 1, aimZ: 0, autoAim: true, dash: false, skill: false };
      const run = (secs: number) => {
        for (let i = 0; i < 60 * secs; i++) {
          sim.player.hp = sim.player.st.maxHp;
          sim.step(1 / 60, input);
          while (sim.pending.length) choose(sim, 0);
          sim.events.length = 0;
        }
      };
      run(25);
      expect(sim.player.skillCd).toBe(0);
      input.skill = true;
      sim.player.hp = sim.player.st.maxHp;
      sim.step(1 / 60, input);
      input.skill = false;
      expect(sim.events.some((e) => e.t === 'skill' && e.id === sim.skill)).toBe(true);
      expect(sim.player.skillCd).toBeGreaterThan(10);
      sim.events.length = 0;
      run(31);
      expect(sim.player.skillCd).toBe(0);
    }
  }, 60000);
  it('pacts make the night harder and the reward bigger', () => {
    const plain = new Sim({ seed: 3, char: 'kindler', difficulty: 0, biome: 'ashwood', meta: {} });
    const sworn = new Sim({ seed: 3, char: 'kindler', difficulty: 0, biome: 'ashwood', meta: {}, pacts: ['bloodmoon', 'swarm', 'frailty', 'famine', 'haste'] });
    expect(sworn.diff.hp).toBeCloseTo(plain.diff.hp * 1.35);
    expect(sworn.diff.spawn).toBeCloseTo(plain.diff.spawn * 1.3);
    expect(sworn.diff.cinder).toBeCloseTo(plain.diff.cinder * 2.1);
    expect(sworn.player.st.maxHp).toBe(Math.round(plain.player.st.maxHp * 0.7));
    const a = plain.spawnEnemy('shade', 5, 5), b = sworn.spawnEnemy('shade', 5, 5);
    expect(b.hp / a.hp).toBeCloseTo(1.35);
    expect(b.speed / a.speed).toBeGreaterThan(1.05);
  });
  it('shrines offer a bargain once', () => {
    let total = 0;
    for (let seed = 1; seed <= 12; seed++) total += new Sim({ seed, char: 'kindler', difficulty: 0, biome: 'ashwood', meta: {} }).shrines.length;
    expect(total).toBeGreaterThan(24);
    const sim = new Sim({ seed: 4, char: 'kindler', difficulty: 0, biome: 'ashwood', meta: {} });
    const s = sim.shrines[0];
    const input = { mx: 0, mz: 0, aimX: 1, aimZ: 0, autoAim: true, dash: false };
    sim.player.x = s.x;
    sim.player.z = s.z;
    sim.step(1 / 60, input);
    expect(sim.pending[0]?.type).toBe('shrine');
    expect(sim.pending[0].choices).toHaveLength(3);
    const hp = sim.player.st.maxHp;
    sim.pending[0].choices[0] = { type: 'boon', id: 'ward' };
    choose(sim, 0);
    expect(sim.player.st.maxHp).toBe(hp + 25);
    expect(s.used).toBe(true);
    sim.step(1 / 60, input);
    expect(sim.pending.some((p) => p.type === 'shrine')).toBe(false);
  });
  it('two weapons at level 3 form a synergy', () => {
    const sim = new Sim({ seed: 8, char: 'frostweaver', difficulty: 0, biome: 'ashwood', meta: {} });
    sim.player.weapons = [{ id: 'frost', level: 3, t: 0, a: 0, b: 0, dealt: 0 }, { id: 'arc', level: 2, t: 0, a: 0, b: 0, dealt: 0 }];
    sim.recalc();
    expect(sim.synergies.has('superconduct')).toBe(false);
    sim.player.weapons[1].level = 3;
    sim.recalc();
    expect(sim.synergies.has('superconduct')).toBe(true);
    const e = sim.spawnEnemy('brute', 3, 3, false, 1);
    expect(sim.synergyMul('arc', e)).toBe(1);
    sim.chill(e, 2);
    expect(sim.synergyMul('arc', e)).toBeCloseTo(1.4);
  });
  it('omens come and go', () => {
    const sim = new Sim({ seed: 12, char: 'kindler', difficulty: 0, biome: 'ashwood', meta: {} });
    const input = { mx: 0.3, mz: 0.2, aimX: 1, aimZ: 0, autoAim: true, dash: false };
    let seen = false;
    for (let i = 0; i < 60 * 200; i++) {
      sim.player.hp = sim.player.st.maxHp;
      sim.step(1 / 60, input);
      while (sim.pending.length) choose(sim, 0);
      sim.events.length = 0;
      if (sim.omen) seen = true;
    }
    expect(seen).toBe(true);
    expect(sim.omen).toBeNull();
  }, 60000);
  it('the trial starts built up and the boss arrives quickly', () => {
    const sim = new Sim({ seed: 14, char: 'kindler', difficulty: 0, biome: 'ashwood', meta: {}, trial: true });
    expect(sim.player.weapons.length).toBe(4);
    expect(sim.beacons.every((b) => b.lit)).toBe(true);
    const input = { mx: 0, mz: 0, aimX: 1, aimZ: 0, autoAim: true, dash: false };
    for (let i = 0; i < 60 * 20 && !sim.boss; i++) {
      sim.player.hp = sim.player.st.maxHp;
      sim.step(1 / 60, input);
      while (sim.pending.length) choose(sim, 0);
      sim.events.length = 0;
    }
    expect(sim.boss?.kind).toBe('eclipse');
  }, 60000);
  it('a trial win does not unlock regions or count as a dawn', () => {
    const save = defaultSave();
    const sim = new Sim({ seed: 15, char: 'kindler', difficulty: 0, biome: 'ashwood', meta: {}, trial: true });
    (sim as unknown as { state: string }).state = 'victory';
    sim.time = 150;
    const sum = finishRun(save, sim);
    expect(sum.win).toBe(true);
    expect(save.biomes).toEqual(['ashwood']);
    expect(save.stats.wins).toBe(0);
    expect(save.stats.bestTrial).toBeGreaterThan(0);
    const real = new Sim({ seed: 15, char: 'kindler', difficulty: 0, biome: 'ashwood', meta: {} });
    (real as unknown as { state: string }).state = 'victory';
    finishRun(save, real);
    expect(save.biomes).toContain('frostmere');
  });
  it('runs every character', () => {
    for (const c of ['stormcaller', 'warden', 'frostweaver', 'ashwalker', 'stargazer'] as const) {
      const r = runBot(77, 1, c, 0.6, 90);
      expect(r.kills).toBeGreaterThan(10);
    }
  }, 60000);
});
