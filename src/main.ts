import { GameView } from './render/view';
import { Sim } from './sim/sim';
import { Input } from './core/input';
import { CHARS } from './sim/defs';
import { choose } from './sim/choices';
import type { InputState } from './sim/types';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const css = document.createElement('style');
css.textContent = 'html,body{margin:0;height:100%;overflow:hidden;background:#05060f}canvas{position:fixed;inset:0;width:100%;height:100%;display:block}#overlay{pointer-events:none}';
document.head.appendChild(css);
const view = new GameView(canvas, overlay);
const input = new Input(document.body);
const qs = new URLSearchParams(location.search);
view.resize(innerWidth, innerHeight);
window.addEventListener('resize', () => view.resize(innerWidth, innerHeight));
const sim = new Sim({ seed: Number(qs.get('seed') ?? 7), char: 'kindler', difficulty: 0, biome: (qs.get('biome') as any) ?? 'ashwood', meta: {} });
view.loadWorld(sim.world, CHARS.kindler);
if (qs.get('menu')) view.setMode('menu');
else { view.setSim(sim); view.setMode('follow'); }
(window as any).view = view; (window as any).sim = sim;
const inp: InputState = { mx: 0, mz: 0, aimX: 1, aimZ: 0, autoAim: true, dash: false };
(window as any).warp = (secs: number, tx = 30, tz = 20, god = true) => {
  const bi: InputState = { mx: 0, mz: 0, aimX: 1, aimZ: 0, autoAim: true, dash: false };
  for (let i = 0; i < secs * 60; i++) {
    while (sim.pending.length) choose(sim, 0);
    const dx = tx - sim.player.x, dz = tz - sim.player.z; const l = Math.hypot(dx, dz);
    const ca = sim.time * 0.5;
    bi.mx = l > 9 ? dx / l : Math.cos(ca); bi.mz = l > 9 ? dz / l : Math.sin(ca);
    if (god) sim.player.hp = sim.player.st.maxHp;
    sim.step(1 / 60, bi); sim.events.length = 0;
  }
  return { t: sim.time, lvl: sim.player.level, hp: sim.player.hp, en: sim.enemies.length, w: sim.player.weapons.map((w) => w.id + w.level) };
};
let last = performance.now();
const gp = { x: 0, z: 0 };
function loop(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  input.poll(dt);
  inp.mx = input.moveX; inp.mz = input.moveY; inp.dash = input.takeDash();
  if (view.groundPoint(input.pointerX, input.pointerY, gp)) {
    const dx = gp.x - sim.player.x, dz = gp.z - sim.player.z; const l = Math.hypot(dx, dz) || 1;
    inp.aimX = dx / l; inp.aimZ = dz / l; inp.autoAim = false;
  }
  if (!qs.get('menu')) {
    while (sim.pending.length) choose(sim, 0);
    sim.step(dt, inp);
    view.handleEvents(sim.events);
    sim.events.length = 0;
  }
  view.frame(dt, dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
