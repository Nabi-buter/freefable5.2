import { describe, expect, it } from 'vitest';
import { runBot } from './simbot';
import { World } from '../src/sim/worldgen';

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
    for (const b of ['frostmere', 'emberwaste'] as const) {
      const r = runBot(31, 0, 'kindler', 0.7, 120, false, b);
      expect(r.kills).toBeGreaterThan(20);
    }
  }, 60000);
  it('runs every character', () => {
    for (const c of ['stormcaller', 'warden', 'frostweaver', 'ashwalker'] as const) {
      const r = runBot(77, 1, c, 0.6, 90);
      expect(r.kills).toBeGreaterThan(10);
    }
  }, 60000);
});
