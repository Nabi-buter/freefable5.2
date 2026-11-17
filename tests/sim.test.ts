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
    for (const b of ['frostmere', 'emberwaste', 'gloommire'] as const) {
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
    for (const c of ['kindler', 'stormcaller', 'warden', 'frostweaver', 'ashwalker', 'stargazer'] as const) {
      const sim = new Sim({ seed: 21, char: c, difficulty: 0, biome: 'ashwood', meta: {} });
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
      expect(sim.events.some((e) => e.t === 'skill' && e.id === sim.char.skill)).toBe(true);
      expect(sim.player.skillCd).toBeGreaterThan(10);
      sim.events.length = 0;
      run(27);
      expect(sim.player.skillCd).toBe(0);
    }
  }, 60000);
  it('runs every character', () => {
    for (const c of ['stormcaller', 'warden', 'frostweaver', 'ashwalker', 'stargazer'] as const) {
      const r = runBot(77, 1, c, 0.6, 90);
      expect(r.kills).toBeGreaterThan(10);
    }
  }, 60000);
});
