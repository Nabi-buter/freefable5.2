import { AudioEngine } from './audio/audio';
import { setLang, t } from './core/i18n';
import { Input } from './core/input';
import { finishRun } from './core/progress';
import { dailyInfo } from './core/daily';
import { SaveStore } from './core/save';
import { GameView } from './render/view';
import { banish, choose, reroll, skip } from './sim/choices';
import { CHARS } from './sim/defs';
import { Sim } from './sim/sim';
import type { InputState } from './sim/types';
import { World } from './sim/worldgen';
import { UI, type UIHost } from './ui/ui';

declare const __APP_VERSION__: string;

type State = 'boot' | 'menu' | 'loading' | 'playing' | 'choosing' | 'paused' | 'ending' | 'result';

class App implements UIHost {
  readonly save = new SaveStore();
  readonly audio = new AudioEngine();
  readonly input: Input;
  readonly version = 'v' + __APP_VERSION__;
  readonly view: GameView;
  readonly ui: UI;
  sim: Sim | null = null;
  state: State = 'boot';
  private inp: InputState = { mx: 0, mz: 0, aimX: 1, aimZ: 0, autoAim: true, dash: false };
  private last = performance.now();
  private hitStopT = 0;
  private endT = 0;
  private chooseDelay = 0;
  private gp = { x: 0, z: 0 };
  private veil = document.getElementById('veil');
  private fps = 60;
  private menuBiome = '';
  private forcedQuality = false;
  private aimCursor = false;
  private runDaily = false;
  /** boss introduction: slow the world and swing the camera over */
  private cine: { t: number; dur: number; x: number; z: number } | null = null;
  private slowT = 0;
  private fpsWin = 0;
  private fpsWinN = 0;

  constructor() {
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    const overlay = document.getElementById('overlay') as HTMLCanvasElement;
    setLang(this.save.data.settings.lang);
    this.input = new Input(document.body);
    this.view = new GameView(canvas, overlay);
    this.ui = new UI(document.getElementById('ui')!, this);
    this.view.affixLabel = (a) => t('affix.' + a);
    // ?q=low|medium|high|ultra overrides the saved quality for this session (handy for testing)
    const q = new URLSearchParams(location.search).get('q');
    if (q === 'low' || q === 'medium' || q === 'high' || q === 'ultra') {
      this.save.data.settings.quality = q;
      this.forcedQuality = true;
    }
    this.view.quality = this.save.data.settings.quality;
    this.view.setQuality(this.save.data.settings.quality);
    this.settingsChanged();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 200));
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchend', unlock);
    document.addEventListener('visibilitychange', () => this.audio.suspend(document.hidden));
    window.addEventListener('wheel', (e) => {
      if (this.state !== 'playing') return;
      const s = this.save.data.settings;
      s.zoom = Math.max(0.75, Math.min(1.3, s.zoom + Math.sign(e.deltaY) * 0.05));
      this.view.zoom = s.zoom;
    }, { passive: true });
    window.addEventListener('beforeunload', () => this.save.save());
    this.toMenu(true);
    requestAnimationFrame((t) => this.loop(t));
  }

  private resize() {
    this.view.resize(window.innerWidth, window.innerHeight);
  }

  // ------------------------------------------------------------ UIHost
  settingsChanged() {
    const s = this.save.data.settings;
    setLang(s.lang);
    this.audio.setVolumes(s.master, s.music, s.sfx);
    this.view.shakeMul = s.shake;
    this.view.showDamage = s.damageNumbers;
    this.view.flashMul = s.reduceFlash ? 0.25 : 1;
    this.view.assist = s.colorAssist;
    this.input.binds = s.keys;
    this.input.pad = s.pad;
    this.input.rumbleOn = s.rumble;
    this.view.overlay.enabled = true;
    this.view.zoom = s.zoom;
    if (this.view.quality !== s.quality) this.view.setQuality(s.quality);
  }

  toggleFullscreen() {
    const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (document.fullscreenElement || d.webkitFullscreenElement) {
      if (document.exitFullscreen) void document.exitFullscreen();
      else d.webkitExitFullscreen?.();
    } else if (el.requestFullscreen) void el.requestFullscreen().catch(() => undefined);
    else el.webkitRequestFullscreen?.();
  }

  private showVeil(on: boolean) {
    this.veil?.classList.toggle('gone', !on);
  }

  toMenu(first = false) {
    const last = this.save.data.last;
    this.sim = null;
    this.state = 'menu';
    const build = () => {
      if (this.menuBiome !== last.biome + last.char || !this.view.world) {
        this.view.loadWorld(new World(20261115, last.biome), CHARS[last.char]);
        this.menuBiome = last.biome + last.char;
      }
      this.view.setSim(null);
      this.view.setMode('menu');
      this.ui.hideHud();
      this.ui.showTitle();
      this.audio.music?.setMood('menu', 0);
      this.audio.setDuck(1);
      setTimeout(() => this.showVeil(false), first ? 250 : 60);
    };
    if (first) build();
    else {
      this.showVeil(true);
      setTimeout(build, 420);
    }
  }

  /** phones: go fullscreen and turn the screen sideways when the browser allows it (needs a user gesture) */
  private goLandscape() {
    if (this.input.device !== 'touch') return;
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    const lock = () => {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      o?.lock?.('landscape').catch(() => undefined);
    };
    try {
      if (document.fullscreenElement) lock();
      else if (el.requestFullscreen) el.requestFullscreen().then(lock).catch(() => undefined);
      else el.webkitRequestFullscreen?.();
    } catch {
      /* not supported: the portrait layout still works */
    }
  }

  startRun(daily = false) {
    this.goLandscape();
    const last = this.save.data.last;
    this.state = 'loading';
    this.runDaily = daily;
    this.showVeil(true);
    setTimeout(() => {
      const d = dailyInfo();
      const cfg = daily
        ? { seed: d.seed, char: d.char, difficulty: 0, biome: d.biome, meta: this.save.data.meta }
        : { seed: (Math.random() * 0xffffffff) >>> 0, char: last.char, difficulty: last.difficulty, biome: last.biome, meta: this.save.data.meta, endless: last.endless && this.save.data.stats.wins > 0 };
      this.sim = new Sim(cfg);
      this.view.loadWorld(this.sim.world, CHARS[cfg.char]);
      this.menuBiome = '';
      this.view.setSim(this.sim);
      this.view.setMode('follow');
      this.ui.showHud();
      this.input.clearQueues();
      this.hitStopT = 0;
      this.cine = null;
      this.view.focusW = 0;
      this.audio.music?.setMood('run', 0);
      this.audio.setDuck(1);
      this.state = 'playing';
      this.last = performance.now();
      setTimeout(() => this.showVeil(false), 80);
    }, 430);
  }

  retry() {
    this.startRun(this.runDaily);
  }

  pauseRequest() {
    if (!this.sim || (this.state !== 'playing' && this.state !== 'paused')) return;
    this.state = 'paused';
    this.ui.showPause(this.sim);
    this.audio.setDuck(0.35);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.input.clearQueues();
    this.audio.setDuck(1);
    this.last = performance.now();
  }

  abandon() {
    if (!this.sim) return;
    this.audio.setDuck(1);
    this.showResult();
  }

  choose(i: number) {
    if (!this.sim) return;
    choose(this.sim, i);
    this.afterChoice();
  }
  reroll(): boolean {
    if (!this.sim) return false;
    const ok = reroll(this.sim);
    if (ok) this.ui.showPending(this.sim);
    return ok;
  }
  banish(i: number): boolean {
    if (!this.sim) return false;
    const ok = banish(this.sim, i);
    this.ui.showPending(this.sim);
    return ok;
  }
  skip() {
    if (!this.sim) return;
    skip(this.sim);
    this.afterChoice();
  }

  private afterChoice() {
    const sim = this.sim!;
    if (sim.pending.length > 0) this.ui.showPending(sim);
    else {
      this.ui.closeModal();
      this.state = 'playing';
      this.input.clearQueues();
      // a breath of safety after menus so nobody dies to a hit they could not see coming
      sim.player.iframe = Math.max(sim.player.iframe, 0.6);
      this.last = performance.now();
    }
  }

  private showResult() {
    const sim = this.sim!;
    const sum = finishRun(this.save.data, sim, this.runDaily);
    this.save.save();
    this.state = 'result';
    this.ui.hideHud();
    this.ui.showResult(sum);
  }

  // ------------------------------------------------------------ frame
  private buildInput(sim: Sim) {
    const inp = this.inp;
    const input = this.input;
    inp.mx = input.moveX;
    inp.mz = input.moveY;
    inp.dash = input.takeDash();
    inp.skill = input.takeSkill();
    const auto = this.save.data.settings.autoAim;
    const p = sim.player;
    if (input.device === 'gamepad') {
      const l = Math.hypot(input.stickAimX, input.stickAimY);
      if (l > 0.35 && !auto) {
        inp.aimX = input.stickAimX / l;
        inp.aimZ = input.stickAimY / l;
        inp.autoAim = false;
      } else inp.autoAim = true;
    } else if (input.device === 'touch' || auto) {
      inp.autoAim = true;
    } else if (this.view.groundPoint(input.pointerX, input.pointerY, this.gp)) {
      const dx = this.gp.x - p.x, dz = this.gp.z - p.z;
      const l = Math.hypot(dx, dz);
      if (l > 0.3) {
        inp.aimX = dx / l;
        inp.aimZ = dz / l;
      }
      inp.autoAim = false;
    }
  }

  private loop(now: number) {
    requestAnimationFrame((t) => this.loop(t));
    const real = Math.min(0.1, Math.max(0.0001, (now - this.last) / 1000));
    this.last = now;
    this.fps += (1 / real - this.fps) * 0.1;
    const dt = Math.min(1 / 20, real);
    this.input.poll(dt);
    const sim = this.sim;
    let simDt = 0;
    let fxDt = dt;

    switch (this.state) {
      case 'playing': {
        if (!sim) break;
        if (this.input.takePause()) {
          this.pauseRequest();
          fxDt = 0;
          break;
        }
        this.input.takeConfirm();
        this.input.takeNav();
        this.input.takeNumber();
        this.input.takeBack();
        this.input.takeKeys();
        this.buildInput(sim);
        simDt = dt;
        if (this.view.hitStop > 0) {
          this.hitStopT = Math.max(this.hitStopT, this.view.hitStop);
          this.view.hitStop = 0;
        }
        if (this.hitStopT > 0) {
          this.hitStopT -= real;
          simDt *= 0.08;
        }
        if (this.cine) {
          const c = this.cine;
          c.t += real;
          const u = c.t / c.dur;
          // ease in, hold, ease out
          this.view.focusW = Math.min(1, u * 4) * Math.min(1, (1 - u) * 3.5);
          this.view.focusX = c.x;
          this.view.focusZ = c.z;
          simDt *= 0.12;
          this.inp.dash = false;
          this.inp.skill = false;
          sim.player.iframe = Math.max(sim.player.iframe, 0.4);
          if (u >= 1) {
            this.cine = null;
            this.view.focusW = 0;
          }
        }
        sim.step(simDt, this.inp);
        fxDt = simDt > 0 ? Math.max(simDt, dt * 0.35) : dt;
        this.drainEvents(sim);
        if (sim.pending.length > 0 && this.chooseDelay <= 0) this.chooseDelay = sim.pending[0].type === 'levelup' ? 0.28 : 0.6;
        if (this.chooseDelay > 0) {
          this.chooseDelay -= real;
          if (this.chooseDelay <= 0 && sim.pending.length > 0) {
            this.state = 'choosing';
            this.ui.showPending(sim);
          }
        }
        if (sim.state === 'dead') {
          this.state = 'ending';
          this.endT = 2.8;
          this.view.setMode('death');
          this.ui.fadeHud();
          this.audio.music?.setMood('death', 0);
        } else if (sim.state === 'victory') {
          this.state = 'ending';
          this.endT = 9.5;
          this.view.setMode('victory');
          this.ui.fadeHud();
        }
        // music follows the run
        const m = this.audio.music;
        if (m && sim.state === 'playing') {
          if (sim.stats.bossKilled) m.setMood('victory', 1);
          else if (sim.boss) m.setMood('boss', 4);
          else {
            const I = sim.intensity();
            m.setMood('run', I < 2 ? 0 : I < 5 ? 1 : I < 9 ? 2 : 3);
          }
        }
        this.ui.updateHud(sim, real, this.fps);
        this.autoQuality(real);
        break;
      }
      case 'choosing':
        this.ui.pollInput(this.input);
        fxDt = dt * 0.25;
        break;
      case 'paused':
        this.ui.pollInput(this.input);
        fxDt = 0;
        break;
      case 'ending':
        this.endT -= real;
        this.input.clearQueues();
        if (this.endT <= 0) this.showResult();
        break;
      case 'menu':
      case 'result':
        this.ui.pollInput(this.input);
        break;
      default:
        break;
    }
    const aim = this.state === 'playing' && this.input.device === 'kbm' && !this.save.data.settings.autoAim;
    if (aim !== this.aimCursor) {
      this.aimCursor = aim;
      document.body.classList.toggle('aim', aim);
    }
    this.audio.music?.update();
    this.view.frame(fxDt, this.state === 'paused' ? 0.0001 : real);
  }

  /** step the quality down when the frame rate stays under ~27 fps for several seconds */
  private autoQuality(real: number) {
    const s = this.save.data.settings;
    if (!s.autoQuality || this.forcedQuality || s.quality === 'low') return;
    this.fpsWin += real;
    this.fpsWinN++;
    if (this.fpsWin < 2) return;
    const fps = this.fpsWinN / this.fpsWin;
    this.fpsWin = 0;
    this.fpsWinN = 0;
    this.slowT = fps < 27 ? this.slowT + 1 : 0;
    if (this.slowT >= 3) {
      this.slowT = 0;
      s.quality = s.quality === 'ultra' ? 'high' : s.quality === 'high' ? 'medium' : 'low';
      this.view.setQuality(s.quality);
      this.save.save();
      this.ui.toast(t('set.autoq'));
      this.last = performance.now();
    }
  }

  private drainEvents(sim: Sim) {
    const ev = sim.events;
    if (ev.length === 0) return;
    this.view.handleEvents(ev);
    this.audio.handle(ev, sim);
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (e.t === 'announce') this.ui.announce(e.key, e.tone);
      else if (e.t === 'hurt') this.input.rumble(Math.min(1, 0.45 + e.dmg / 40), 0.6, 160);
      else if (e.t === 'dash') this.input.rumble(0, 0.35, 70);
      else if (e.t === 'skill') this.input.rumble(0.7, 0.9, 260);
      else if (e.t === 'levelup') this.input.rumble(0.25, 0.5, 120);
      else if (e.t === 'beaconLit') this.input.rumble(0.8, 0.8, 420);
      else if (e.t === 'bossPhase' || e.t === 'bossDie') this.input.rumble(1, 0.8, 600);
      else if (e.t === 'death') this.input.rumble(1, 1, 700);
      else if (e.t === 'explode' && e.hostile) {
        const dx = e.x - sim.player.x, dz = e.z - sim.player.z;
        if (dx * dx + dz * dz < 144) this.input.rumble(0.5, 0.3, 140);
      }
      else if (e.t === 'bossSpawn') {
        const big = e.kind === 'eclipse';
        this.cine = { t: 0, dur: big ? 3.2 : 2.0, x: e.x, z: e.z };
        this.input.rumble(big ? 0.9 : 0.6, 0.5, big ? 900 : 500);
        this.ui.bossCard(e.kind, big ? 3.2 : 2.0);
      }
    }
    ev.length = 0;
  }
}

function fatal(ko: string, en: string) {
  const veil = document.getElementById('veil');
  if (!veil) return;
  veil.classList.remove('gone');
  const msg = veil.querySelector('.msg') as HTMLElement | null;
  if (msg) {
    msg.style.letterSpacing = '0.04em';
    msg.style.textTransform = 'none';
    msg.style.maxWidth = '30em';
    msg.style.textAlign = 'center';
    msg.style.lineHeight = '1.7';
    msg.innerHTML = `${ko}<br>${en}`;
  }
}

let app: App;
try {
  app = new App();
  document.getElementById('game')!.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    fatal('그래픽 장치 연결이 끊겼습니다. 페이지를 새로고침해 주세요.', 'The graphics context was lost. Please reload the page.');
  });
} catch (err) {
  console.error(err);
  fatal('이 브라우저에서는 WebGL 2를 사용할 수 없어 게임을 실행할 수 없습니다.', 'CINDERWAKE needs WebGL 2, which is not available in this browser.');
  throw err;
}

// ---- offline support: cache the game after the first visit
if ('serviceWorker' in navigator && import.meta.env.PROD && !new URLSearchParams(location.search).has('debug')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}

// ---- debugging hooks (only with ?debug in the URL)
if (new URLSearchParams(location.search).has('debug')) {
  const w = window as unknown as Record<string, unknown>;
  w.app = app;
  w.warp = (secs: number, god = true, tx?: number, tz?: number) => {
    const sim = app.sim;
    if (!sim) return null;
    const bi: InputState = { mx: 0, mz: 0, aimX: 1, aimZ: 0, autoAim: true, dash: false };
    for (let i = 0; i < secs * 60; i++) {
      while (sim.pending.length) choose(sim, 0);
      const gx = tx ?? 30, gz = tz ?? 20;
      const dx = gx - sim.player.x, dz = gz - sim.player.z;
      const l = Math.hypot(dx, dz);
      const ca = sim.time * 0.5;
      bi.mx = l > 5 ? dx / l : Math.cos(ca);
      bi.mz = l > 5 ? dz / l : Math.sin(ca);
      if (god) sim.player.hp = sim.player.st.maxHp;
      sim.step(1 / 60, bi);
      sim.events.length = 0;
    }
    return { t: sim.time, lvl: sim.player.level, en: sim.enemies.length, beacons: sim.stats.beacons, w: sim.player.weapons.map((x) => x.id + x.level) };
  };
  // scenario shortcuts for screenshots
  w.cheat = {
    lightAll() {
      const sim = app.sim as unknown as { beacons: { lit: boolean }[]; lightBeacon(i: number): void; pending: unknown[] } | null;
      if (!sim) return;
      sim.beacons.forEach((b, i) => {
        if (!b.lit) sim.lightBeacon(i);
      });
      while (app.sim!.pending.length) choose(app.sim!, 0);
    },
    boss() {
      (w.cheat as { lightAll(): void }).lightAll();
      app.sim!.bossT = 0.05;
    },
    win() {
      if (app.sim?.boss) app.sim.boss.hp = 1;
    },
    die() {
      const sim = app.sim;
      if (!sim) return;
      sim.player.revives = 0;
      sim.player.iframe = 0;
      sim.player.hp = 1;
      sim.hurtPlayer(9999, sim.player.x + 1, sim.player.z);
    },
    /** replace the build with the given weapons at a level (7 = evolved) */
    build(ids: string[], level = 7) {
      const sim = app.sim;
      if (!sim) return;
      sim.player.weapons = ids.map((id) => ({ id, level, t: 0.2, a: 0, b: 0, dealt: 0 })) as typeof sim.player.weapons;
      sim.recalc();
    },
    /** run the real step + event + render pipeline n times with a wandering god-mode player */
    soak(n: number, dt = 1 / 30) {
      const sim = app.sim;
      if (!sim) return null;
      const self = app as unknown as { drainEvents(s: Sim): void };
      const bi: InputState = { mx: 0, mz: 0, aimX: 1, aimZ: 0, autoAim: true, dash: false };
      let events = 0;
      for (let i = 0; i < n; i++) {
        while (sim.pending.length) choose(sim, 0);
        const a = sim.time * 0.4;
        bi.mx = Math.cos(a);
        bi.mz = Math.sin(a);
        bi.dash = i % 90 === 0;
        sim.player.hp = sim.player.st.maxHp;
        sim.step(dt, bi);
        events += sim.events.length;
        self.drainEvents(sim);
        app.view.frame(dt, dt);
      }
      return { t: sim.time, events, en: sim.enemies.length, zones: sim.zones.length, projs: sim.projs.length, state: sim.state };
    },
    level(n: number) {
      const sim = app.sim;
      if (!sim) return;
      for (let i = 0; i < n; i++) {
        sim.addXp(sim.player.xpNext / sim.player.st.xp + 0.01);
        while (sim.pending.length) choose(sim, 0);
      }
    },
  };
}
