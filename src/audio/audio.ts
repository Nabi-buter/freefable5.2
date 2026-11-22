import type { SimEvent } from '../sim/types';
import type { Sim } from '../sim/sim';

/**
 * Everything you hear is synthesised at runtime with the Web Audio API:
 * no samples, no downloads. `Sfx` builds one-shot sounds from oscillators and
 * filtered noise; `Music` is a small generative sequencer whose layers fade in
 * and out with the intensity of the run.
 */

type Wave = OscillatorType;

interface ToneOpts {
  type?: Wave;
  to?: number;
  vol?: number;
  attack?: number;
  delay?: number;
  detune?: number;
  rev?: number;
  curve?: number;
}
interface NoiseOpts {
  vol?: number;
  type?: BiquadFilterType;
  freq?: number;
  to?: number;
  q?: number;
  attack?: number;
  delay?: number;
  rev?: number;
}

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private revIn!: GainNode;
  private noiseBuf!: AudioBuffer;
  private last = new Map<string, number>();
  private vol = { master: 0.8, music: 0.6, sfx: 0.8 };
  private xpStep = 0;
  private xpT = 0;
  music: Music | null = null;
  private duck = 1;

  /** must be called from a user gesture */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    let ctx: AudioContext;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.master.connect(comp);
    comp.connect(ctx.destination);
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);
    // generated impulse response: exponentially decaying stereo noise
    const len = Math.floor(ctx.sampleRate * 2.6);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.8) * (1 - Math.exp(-i / 300));
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    this.revIn = ctx.createGain();
    const revOut = ctx.createGain();
    revOut.gain.value = 0.9;
    this.revIn.connect(conv);
    conv.connect(revOut);
    revOut.connect(this.master);
    const nl = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, nl, ctx.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nl; i++) nd[i] = Math.random() * 2 - 1;
    this.music = new Music(ctx, this.musicBus, this.revIn);
    this.applyVolumes();
  }

  setVolumes(master: number, music: number, sfx: number) {
    this.vol = { master, music, sfx };
    this.applyVolumes();
  }

  private applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.vol.master, t, 0.03);
    this.sfxBus.gain.setTargetAtTime(this.vol.sfx * 1.5, t, 0.03);
    this.musicBus.gain.setTargetAtTime(this.vol.music * 1.3 * this.duck, t, 0.2);
  }

  private amb: { src: AudioBufferSourceNode; gain: GainNode; lfo: OscillatorNode } | null = null;

  /** a quiet bed of regional sound under the music (wind, hum, crackle); null stops it */
  setAmbience(region: string | null) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (this.amb) {
      const old = this.amb;
      old.gain.gain.setTargetAtTime(0, t, 0.6);
      setTimeout(() => {
        try { old.src.stop(); old.lfo.stop(); } catch { /* already stopped */ }
      }, 3000);
      this.amb = null;
    }
    if (!region) return;
    const cfg: Record<string, { type: BiquadFilterType; freq: number; q: number; vol: number; lfo: number; depth: number }> = {
      ashwood: { type: 'bandpass', freq: 500, q: 0.6, vol: 0.018, lfo: 0.08, depth: 180 },
      frostmere: { type: 'highpass', freq: 1800, q: 0.5, vol: 0.016, lfo: 0.12, depth: 600 },
      emberwaste: { type: 'bandpass', freq: 2600, q: 2.5, vol: 0.012, lfo: 3.2, depth: 900 },
      gloommire: { type: 'lowpass', freq: 220, q: 4, vol: 0.05, lfo: 0.2, depth: 60 },
      stormcrag: { type: 'bandpass', freq: 700, q: 0.8, vol: 0.03, lfo: 0.17, depth: 450 },
    };
    const c = cfg[region] ?? cfg.ashwood;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = c.type;
    f.frequency.value = c.freq;
    f.Q.value = c.q;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = c.lfo;
    const lg = ctx.createGain();
    lg.gain.value = c.depth;
    lfo.connect(lg);
    lg.connect(f.frequency);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(c.vol, t, 1.5);
    src.connect(f);
    f.connect(gain);
    gain.connect(this.musicBus);
    src.start();
    lfo.start();
    this.amb = { src, gain, lfo };
  }

  /** lower the music briefly (pause menu, big moments) */
  setDuck(v: number) {
    if (this.duck === v) return;
    this.duck = v;
    this.applyVolumes();
  }

  suspend(on: boolean) {
    if (!this.ctx) return;
    if (on && this.ctx.state === 'running') void this.ctx.suspend();
    else if (!on && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private ok(id: string, minGap: number): boolean {
    if (!this.ctx || this.ctx.state !== 'running') return false;
    const now = this.ctx.currentTime;
    const l = this.last.get(id) ?? -1;
    if (now - l < minGap) return false;
    this.last.set(id, now);
    return true;
  }

  // ------------------------------------------------------------ primitives
  private tone(freq: number, dur: number, o: ToneOpts = {}) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(Math.max(20, freq), t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t0 + dur);
    if (o.detune) osc.detune.value = o.detune;
    const v = o.vol ?? 0.2;
    const a = o.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(v, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(a + 0.01, dur));
    osc.connect(g);
    g.connect(this.sfxBus);
    if (o.rev) {
      const r = ctx.createGain();
      r.gain.value = o.rev;
      g.connect(r);
      r.connect(this.revIn);
    }
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, o: NoiseOpts = {}) {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'lowpass';
    f.frequency.setValueAtTime(o.freq ?? 1200, t0);
    if (o.to) f.frequency.exponentialRampToValueAtTime(Math.max(30, o.to), t0 + dur);
    f.Q.value = o.q ?? 0.8;
    const g = ctx.createGain();
    const v = o.vol ?? 0.2;
    const a = o.attack ?? 0.003;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(v, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(a + 0.01, dur));
    src.connect(f);
    f.connect(g);
    g.connect(this.sfxBus);
    if (o.rev) {
      const r = ctx.createGain();
      r.gain.value = o.rev;
      g.connect(r);
      r.connect(this.revIn);
    }
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur + 0.05);
  }

  private chord(notes: number[], dur: number, o: ToneOpts & { strum?: number } = {}) {
    notes.forEach((n, i) => this.tone(midi(n), dur, { ...o, delay: (o.delay ?? 0) + i * (o.strum ?? 0) }));
  }

  // ------------------------------------------------------------ ui
  ui(kind: 'hover' | 'click' | 'back' | 'deny' | 'buy' | 'select' | 'open') {
    if (!this.ok('ui.' + kind, kind === 'hover' ? 0.03 : 0.02)) return;
    switch (kind) {
      case 'hover': this.tone(1500, 0.03, { type: 'triangle', vol: 0.03 }); break;
      case 'click': this.tone(720, 0.07, { type: 'triangle', to: 980, vol: 0.09 }); break;
      case 'back': this.tone(560, 0.08, { type: 'triangle', to: 380, vol: 0.08 }); break;
      case 'deny': this.tone(190, 0.12, { type: 'square', to: 150, vol: 0.06 }); break;
      case 'open': this.noise(0.18, { type: 'bandpass', freq: 600, to: 2400, vol: 0.05, q: 1.2 }); break;
      case 'buy':
        this.tone(midi(76), 0.12, { type: 'triangle', vol: 0.1, rev: 0.3 });
        this.tone(midi(83), 0.25, { type: 'triangle', vol: 0.1, delay: 0.07, rev: 0.4 });
        break;
      case 'select':
        this.chord([69, 74, 78, 81], 0.5, { type: 'triangle', vol: 0.085, strum: 0.045, rev: 0.5 });
        this.noise(0.25, { type: 'highpass', freq: 5000, vol: 0.03 });
        break;
    }
  }

  // ------------------------------------------------------------ game events
  handle(events: SimEvent[], sim: Sim) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const p = sim.player;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      switch (ev.t) {
        case 'shoot':
          switch (ev.w) {
            case 'ember':
              if (this.ok('s.ember', 0.07)) {
                const d = 1 + (Math.random() - 0.5) * 0.12;
                this.tone(540 * d, 0.09, { type: 'triangle', to: 250, vol: 0.055 });
                this.noise(0.07, { type: 'bandpass', freq: 2200, to: 900, vol: 0.05 });
              }
              break;
            case 'frost':
              if (this.ok('s.frost', 0.1)) {
                this.tone(1900 + Math.random() * 300, 0.1, { to: 2900, vol: 0.03 });
                this.noise(0.1, { type: 'highpass', freq: 5200, vol: 0.035 });
              }
              break;
            case 'arc':
              if (this.ok('s.arc', 0.1)) {
                this.tone(1100, 0.13, { type: 'sawtooth', to: 180, vol: 0.05 });
                this.noise(0.14, { type: 'bandpass', freq: 3800, q: 2, vol: 0.07 });
              }
              break;
            case 'lance':
              if (this.ok('s.lance', 0.1)) {
                this.tone(240, 0.3, { type: 'sawtooth', to: 900, vol: 0.06, rev: 0.3 });
                this.tone(480, 0.3, { type: 'square', to: 1800, vol: 0.025 });
                this.noise(0.3, { type: 'bandpass', freq: 800, to: 5200, vol: 0.07 });
              }
              break;
            case 'nova':
              if (this.ok('s.nova', 0.1)) {
                this.tone(130, 0.36, { to: 44, vol: 0.2 });
                this.noise(0.38, { freq: 2200, to: 180, vol: 0.12, rev: 0.25 });
              }
              break;
            case 'well':
              if (this.ok('s.well', 0.3)) this.tone(90, 0.8, { to: 45, vol: 0.12, type: 'sine', rev: 0.4 });
              break;
            case 'totem':
              if (this.ok('s.totem', 0.3)) {
                this.tone(260, 0.2, { type: 'triangle', to: 180, vol: 0.06 });
                this.noise(0.15, { type: 'bandpass', freq: 900, vol: 0.05 });
              }
              break;
            case 'sprite':
              if (this.ok('s.sprite', 0.09)) this.tone(1500 + Math.random() * 500, 0.07, { type: 'triangle', to: 2400, vol: 0.022 });
              break;
            case 'sigil':
              if (this.ok('s.sigil', 0.25)) {
                this.tone(midi(74), 0.25, { type: 'triangle', vol: 0.035, rev: 0.5 });
                this.tone(midi(81), 0.3, { type: 'sine', vol: 0.025, rev: 0.6, delay: 0.06 });
              }
              break;
            case 'starfall':
              if (this.ok('s.star', 0.2)) this.tone(1500, 0.5, { to: 420, vol: 0.03, type: 'triangle' });
              break;
            case 'darts':
              if (this.ok('s.darts', 0.1)) this.tone(640, 0.08, { type: 'triangle', to: 1150, vol: 0.045 });
              break;
            case 'glaive':
              if (this.ok('s.glaive', 0.1)) this.noise(0.28, { type: 'bandpass', freq: 500, to: 2600, q: 2.5, vol: 0.08 });
              break;
            default:
              break;
          }
          break;
        case 'hit':
          if (ev.crit) {
            if (this.ok('crit', 0.06)) this.tone(1250 + Math.random() * 200, 0.09, { type: 'triangle', vol: 0.05, rev: 0.2 });
          } else if (this.ok('hit', 0.045)) this.tone(300 + Math.random() * 240, 0.04, { type: 'triangle', to: 160, vol: 0.04 });
          break;
        case 'kill':
          if (ev.elite) {
            if (this.ok('killE', 0.1)) {
              this.tone(170, 0.5, { to: 40, vol: 0.24 });
              this.noise(0.5, { freq: 1600, to: 90, vol: 0.2, rev: 0.4 });
              this.chord([74, 81, 86], 0.6, { type: 'triangle', vol: 0.05, strum: 0.05, rev: 0.5, delay: 0.05 });
            }
          } else if (this.ok('kill', 0.05)) {
            const d = 0.8 + Math.random() * 0.5;
            this.noise(0.11, { freq: 1400 * d, to: 200, vol: 0.075 });
            this.tone(210 * d, 0.1, { to: 70, vol: 0.06 });
          }
          break;
        case 'explode':
          if (this.ok('explode', 0.07)) {
            const k = Math.min(1.6, 0.5 + ev.r / 6);
            this.tone(110, 0.3 * k, { to: 36, vol: 0.2 * Math.min(1, k) });
            this.noise(0.35 * k, { freq: 1900, to: 110, vol: 0.14 * Math.min(1, k), rev: 0.3 });
          }
          break;
        case 'lightning':
          if (this.ok('zap', 0.12)) {
            this.noise(0.22, { type: 'bandpass', freq: 4200, to: 900, q: 1.4, vol: 0.09 });
            this.tone(1600, 0.12, { type: 'sawtooth', to: 200, vol: 0.035 });
          }
          break;
        case 'beam':
          break;
        case 'pickup':
          if (ev.kind === 'xp') {
            if (this.ok('xp', 0.04)) {
              const now = this.ctx.currentTime;
              if (now - this.xpT > 0.7) this.xpStep = 0;
              this.xpT = now;
              const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
              const n = 76 + scale[Math.min(scale.length - 1, this.xpStep)];
              this.xpStep = Math.min(scale.length - 1, this.xpStep + 1);
              this.tone(midi(n), 0.08, { type: 'sine', vol: 0.045 });
            }
          } else if (ev.kind === 'cinder') {
            if (this.ok('coin', 0.05)) {
              this.tone(midi(83), 0.07, { type: 'square', vol: 0.03 });
              this.tone(midi(88), 0.16, { type: 'square', vol: 0.03, delay: 0.06 });
            }
          } else if (ev.kind === 'heal') {
            this.chord([72, 76, 79], 0.5, { type: 'sine', vol: 0.08, strum: 0.07, rev: 0.5 });
          } else if (ev.kind === 'magnet') {
            this.tone(300, 0.5, { to: 1400, vol: 0.07, type: 'triangle', rev: 0.4 });
          } else if (ev.kind === 'chest') {
            this.chord([67, 72, 76, 79, 84], 0.9, { type: 'triangle', vol: 0.09, strum: 0.07, rev: 0.6 });
          }
          break;
        case 'levelup':
          if (this.ok('levelup', 0.2)) {
            this.chord([62, 66, 69, 74, 78], 0.8, { type: 'triangle', vol: 0.11, strum: 0.06, rev: 0.6 });
            this.tone(midi(86), 0.9, { vol: 0.06, delay: 0.3, rev: 0.7 });
            this.noise(0.5, { type: 'highpass', freq: 4000, vol: 0.035, attack: 0.2 });
          }
          break;
        case 'hurt':
          if (this.ok('hurt', 0.1)) {
            this.tone(150, 0.22, { type: 'square', to: 62, vol: 0.14 });
            this.noise(0.2, { freq: 900, to: 150, vol: 0.16 });
          }
          break;
        case 'heal':
          break;
        case 'dash':
          this.noise(0.2, { type: 'bandpass', freq: 500, to: 2800, q: 1.4, vol: 0.1 });
          break;
        case 'beaconStart':
          this.tone(midi(50), 1.6, { type: 'sawtooth', to: midi(57), vol: 0.05, attack: 0.5, rev: 0.6 });
          this.tone(midi(62), 1.6, { type: 'triangle', to: midi(69), vol: 0.05, attack: 0.5, rev: 0.6 });
          break;
        case 'beaconLit':
          this.tone(70, 1.4, { to: 30, vol: 0.34 });
          this.noise(1.6, { freq: 3000, to: 120, vol: 0.2, rev: 0.6 });
          this.chord([50, 57, 62, 66, 69, 74, 78, 81], 2.6, { type: 'triangle', vol: 0.09, strum: 0.06, rev: 0.8, attack: 0.02 });
          this.chord([86, 90, 93], 2.2, { type: 'sine', vol: 0.05, strum: 0.12, delay: 0.5, rev: 0.9 });
          break;
        case 'beaconPulse':
          if (Math.hypot(ev.x - p.x, ev.z - p.z) < 26 && this.ok('pulse', 0.5)) this.tone(96, 0.4, { to: 52, vol: 0.09, rev: 0.4 });
          break;
        case 'bossSpawn':
          this.tone(52, 2.2, { type: 'sawtooth', to: 38, vol: 0.16, attack: 0.3, rev: 0.5 });
          this.tone(55, 2.2, { type: 'sawtooth', to: 41, vol: 0.12, attack: 0.3, detune: 30 });
          this.noise(2.0, { freq: 300, to: 1800, vol: 0.12, attack: 0.8, rev: 0.5 });
          this.chord([38, 44, 49], 2.4, { type: 'square', vol: 0.035, rev: 0.6, delay: 0.2 });
          break;
        case 'bossPhase':
          this.chord([45, 51, 56, 62], 1.2, { type: 'sawtooth', vol: 0.06, rev: 0.6 });
          this.noise(0.8, { freq: 2600, to: 150, vol: 0.2, rev: 0.4 });
          break;
        case 'bossDie':
          this.tone(90, 2.4, { to: 24, vol: 0.4 });
          this.noise(2.6, { freq: 4200, to: 80, vol: 0.3, rev: 0.7 });
          if (ev.kind === 'eclipse') this.chord([50, 57, 62, 66, 69, 74, 78, 81, 86], 4, { type: 'triangle', vol: 0.09, strum: 0.11, delay: 0.8, rev: 0.9 });
          else this.chord([57, 64, 69, 73], 1.6, { type: 'triangle', vol: 0.08, strum: 0.08, delay: 0.2, rev: 0.7 });
          break;
        case 'spit':
          if (Math.hypot(ev.x - p.x, ev.z - p.z) < 22 && this.ok('spit', 0.08)) this.tone(340, 0.1, { to: 180, type: 'square', vol: 0.03 });
          break;
        case 'charge':
          if (this.ok('charge', 0.15)) this.noise(0.4, { type: 'bandpass', freq: 300, to: 1800, q: 2, vol: 0.09 });
          break;
        case 'revive':
          this.chord([57, 62, 66, 69, 74, 78], 1.6, { type: 'triangle', vol: 0.12, strum: 0.05, rev: 0.8 });
          this.noise(0.9, { freq: 600, to: 4000, vol: 0.14 });
          break;
        case 'death':
          this.chord([62, 60, 57, 53, 50], 2.4, { type: 'triangle', vol: 0.11, strum: 0.3, rev: 0.8 });
          this.tone(73, 3, { to: 36, vol: 0.2, type: 'sawtooth', attack: 0.1 });
          break;
        case 'victory':
          this.chord([62, 66, 69, 74, 78, 81, 86], 4, { type: 'triangle', vol: 0.11, strum: 0.16, rev: 0.9 });
          break;
        case 'skill':
          switch (ev.id) {
            case 'flare':
              this.tone(90, 0.7, { to: 36, vol: 0.26 });
              this.noise(0.7, { freq: 2600, to: 140, vol: 0.2, rev: 0.4 });
              this.tone(midi(62), 0.5, { type: 'triangle', vol: 0.06, rev: 0.6 });
              break;
            case 'tempest':
              this.noise(0.5, { type: 'bandpass', freq: 5200, to: 600, q: 1.2, vol: 0.2, rev: 0.5 });
              this.tone(1400, 0.22, { type: 'sawtooth', to: 120, vol: 0.09 });
              this.tone(70, 0.9, { to: 34, vol: 0.24, rev: 0.4 });
              break;
            case 'bulwark':
              this.tone(196, 0.8, { type: 'triangle', vol: 0.14, rev: 0.7 });
              this.tone(294, 0.8, { type: 'triangle', vol: 0.1, rev: 0.7 });
              this.tone(80, 0.5, { to: 42, vol: 0.22 });
              this.noise(0.3, { freq: 1400, to: 200, vol: 0.1 });
              break;
            case 'deepfreeze':
              this.tone(2600, 0.9, { to: 900, vol: 0.05, rev: 0.8 });
              this.tone(1950, 1.1, { to: 700, vol: 0.04, type: 'triangle', rev: 0.8 });
              this.noise(0.9, { type: 'bandpass', freq: 6400, to: 1800, q: 2, vol: 0.12, rev: 0.6 });
              this.tone(110, 0.6, { to: 50, vol: 0.16 });
              break;
            case 'reflect':
              this.tone(1200, 0.5, { type: 'triangle', to: 1800, vol: 0.05, rev: 0.6 });
              this.tone(1800, 0.5, { type: 'sine', to: 2400, vol: 0.03, rev: 0.6 });
              break;
            case 'whirl':
              this.noise(1.0, { type: 'bandpass', freq: 600, to: 1800, q: 2, vol: 0.12 });
              break;
            case 'overclock':
              this.tone(220, 0.6, { type: 'sawtooth', to: 880, vol: 0.05 });
              this.tone(330, 0.6, { type: 'square', to: 1320, vol: 0.025 });
              break;
            case 'barrage':
              this.noise(1.4, { type: 'bandpass', freq: 1200, to: 2600, q: 1.5, vol: 0.1 });
              break;
            case 'pyre':
              this.noise(0.9, { freq: 900, to: 300, vol: 0.16, rev: 0.4 });
              this.tone(110, 0.8, { to: 70, vol: 0.18 });
              break;
            case 'blink':
              this.tone(2400, 0.18, { type: 'sawtooth', to: 300, vol: 0.06 });
              this.noise(0.25, { type: 'bandpass', freq: 4800, to: 900, q: 1.5, vol: 0.14 });
              break;
            case 'sanctuary':
              this.chord([67, 71, 74, 79], 1.4, { type: 'triangle', vol: 0.06, strum: 0.05, rev: 0.9 });
              break;
            case 'vortex':
              this.noise(1.3, { type: 'bandpass', freq: 400, to: 3200, q: 1.2, vol: 0.12, rev: 0.4 });
              this.tone(2000, 1.2, { to: 700, vol: 0.03, type: 'triangle' });
              break;
            case 'effigy':
              this.noise(0.6, { freq: 1500, to: 400, vol: 0.13 });
              this.tone(160, 0.5, { to: 90, vol: 0.14, type: 'triangle' });
              break;
            case 'stasis':
              this.tone(1800, 1.4, { to: 1750, vol: 0.05, type: 'sine', rev: 0.9 });
              this.tone(900, 1.4, { to: 880, vol: 0.05, type: 'triangle', rev: 0.9 });
              this.noise(0.4, { type: 'highpass', freq: 6000, vol: 0.06, rev: 0.8 });
              break;
            case 'starcall':
              this.chord([74, 78, 81, 86], 1.2, { type: 'triangle', vol: 0.07, strum: 0.07, rev: 0.8 });
              this.tone(2200, 1.0, { to: 500, vol: 0.04, type: 'triangle', rev: 0.7 });
              break;
            case 'cinderstep':
              this.noise(0.45, { type: 'bandpass', freq: 700, to: 3600, q: 1.4, vol: 0.14 });
              this.tone(180, 0.35, { to: 520, type: 'sawtooth', vol: 0.05 });
              break;
          }
          break;
        case 'shrine':
          this.chord([62, 69, 74, 78], 1.6, { type: 'triangle', vol: 0.07, strum: 0.09, rev: 0.9 });
          break;
        case 'skillReady':
          this.tone(midi(81), 0.12, { type: 'triangle', vol: 0.05, rev: 0.4 });
          this.tone(midi(88), 0.2, { type: 'triangle', vol: 0.05, rev: 0.5, delay: 0.07 });
          break;
        case 'freeze':
          if (this.ok('freeze', 0.08)) this.tone(2400 + Math.random() * 600, 0.16, { vol: 0.035, rev: 0.4 });
          break;
        case 'announce':
          if (ev.tone === 'warn' && this.ok('warn', 0.5)) {
            this.tone(midi(62), 0.22, { type: 'square', vol: 0.045, rev: 0.3 });
            this.tone(midi(59), 0.4, { type: 'square', vol: 0.045, delay: 0.2, rev: 0.3 });
          }
          break;
        case 'spawnElite':
          break;
        default:
          break;
      }
    }
  }
}

// =====================================================================================
// Generative music
// =====================================================================================
export type MusicMood = 'menu' | 'run' | 'boss' | 'victory' | 'death' | 'silent';

// four chords, two bars each (D minor: i – VI – III – VII), voiced low → high
const PROG_MINOR = [
  [38, 50, 57, 62, 65, 69], // Dm
  [34, 46, 53, 58, 62, 65], // Bb
  [41, 53, 57, 60, 65, 69], // F
  [36, 48, 55, 60, 64, 67], // C
];
/** each region plays the run in its own colour (the boss and dawn themes stay shared) */
const PROG_REGION: Record<string, number[][]> = {
  ashwood: [
    [38, 50, 57, 62, 65, 69], // Dm
    [34, 46, 53, 58, 62, 65], // Bb
    [41, 53, 57, 60, 65, 69], // F
    [36, 48, 55, 60, 64, 67], // C
  ],
  frostmere: [
    [40, 52, 59, 64, 67, 71], // Em(add9 feel)
    [36, 48, 55, 60, 64, 71], // Cmaj7
    [43, 55, 59, 62, 67, 74], // G
    [38, 50, 57, 62, 66, 69], // D
  ],
  emberwaste: [
    [33, 45, 52, 57, 60, 64], // Am
    [34, 46, 53, 58, 62, 65], // Bb (phrygian bite)
    [33, 45, 52, 57, 60, 64], // Am
    [31, 43, 50, 55, 59, 62], // G
  ],
  stormcrag: [
    [33, 45, 52, 57, 60, 64], // Am
    [29, 41, 48, 53, 57, 60], // F
    [31, 43, 50, 55, 59, 62], // G
    [28, 40, 47, 52, 56, 59], // E (dominant tension)
  ],
  gloommire: [
    [37, 49, 56, 61, 64, 68], // C#m
    [33, 45, 52, 57, 61, 64], // A
    [35, 47, 54, 59, 63, 66], // B
    [32, 44, 51, 56, 60, 63], // G#
  ],
};
const PROG_BOSS = [
  [38, 50, 57, 62, 65, 68], // Dm(b5 colour)
  [39, 51, 58, 63, 67, 70], // Eb
  [36, 48, 55, 60, 63, 67], // Cm
  [33, 45, 52, 57, 61, 64], // A
];
const PROG_MAJOR = [
  [38, 50, 57, 62, 66, 69], // D
  [43, 55, 59, 62, 67, 71], // G
  [35, 47, 54, 59, 62, 66], // Bm
  [45, 57, 61, 64, 69, 73], // A
];

export class Music {
  private ctx: AudioContext;
  private out: GainNode;
  private rev: GainNode;
  private delayIn: GainNode;
  private padFilter: BiquadFilterNode;
  private noiseBuf: AudioBuffer;
  private nextT = 0;
  private step = 0;
  mood: MusicMood = 'silent';
  /** 0..4 — how many layers play */
  intensity = 0;
  private layer = { pad: 0, bass: 0, arp: 0, drums: 0, lead: 0 };
  private seed = 1;
  private leadNote = 0;

  /** region of the current run: picks the chord colour */
  region = 'ashwood';
  constructor(ctx: AudioContext, out: GainNode, rev: GainNode) {
    this.ctx = ctx;
    this.out = out;
    this.rev = rev;
    // tempo-synced feedback delay for the plucks
    const d = ctx.createDelay(1.5);
    d.delayTime.value = 0.47;
    const fb = ctx.createGain();
    fb.gain.value = 0.36;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    this.delayIn = ctx.createGain();
    this.delayIn.connect(d);
    d.connect(lp);
    lp.connect(fb);
    fb.connect(d);
    lp.connect(out);
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 700;
    this.padFilter.Q.value = 0.6;
    this.padFilter.connect(out);
    const pr = ctx.createGain();
    pr.gain.value = 0.5;
    this.padFilter.connect(pr);
    pr.connect(rev);
    const nl = ctx.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, nl, ctx.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nl; i++) nd[i] = Math.random() * 2 - 1;
  }

  setMood(m: MusicMood, intensity = 0) {
    if (m !== this.mood) {
      this.mood = m;
      // restart the bar on big changes so the downbeat lands with the moment
      if (m === 'boss' || m === 'victory') this.step = Math.ceil(this.step / 16) * 16;
    }
    this.intensity = intensity;
  }

  private rnd(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /** schedule a little ahead of the audio clock; call every frame */
  update() {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (this.nextT < now - 0.5) this.nextT = now + 0.05;
    const bpm = this.mood === 'boss' ? 126 : this.mood === 'menu' ? 84 : this.mood === 'victory' ? 92 : 104 + this.intensity * 3;
    const stepDur = 60 / bpm / 4;
    // layer targets
    const I = this.intensity;
    const m = this.mood;
    const want = { pad: 0, bass: 0, arp: 0, drums: 0, lead: 0 };
    if (m === 'menu') { want.pad = 1; want.arp = 0.7; }
    else if (m === 'run') { want.pad = 0.9; want.arp = I >= 1 ? 0.8 : 0.5; want.bass = I >= 1 ? 1 : 0; want.drums = I >= 2 ? 1 : 0; want.lead = I >= 3 ? 0.8 : 0; }
    else if (m === 'boss') { want.pad = 1; want.arp = 1; want.bass = 1; want.drums = 1; want.lead = 1; }
    else if (m === 'victory') { want.pad = 1; want.arp = 1; want.bass = 0.8; want.lead = 0.8; }
    else if (m === 'death') { want.pad = 0.7; }
    while (this.nextT < now + 0.18) {
      const L = this.layer;
      for (const k of ['pad', 'bass', 'arp', 'drums', 'lead'] as const) L[k] += (want[k] - L[k]) * 0.08;
      this.tick(this.step, this.nextT, stepDur);
      this.step++;
      this.nextT += stepDur;
    }
    const cut = m === 'death' ? 320 : m === 'menu' ? 900 : 700 + I * 420 + (m === 'boss' ? 800 : 0) + (m === 'victory' ? 1600 : 0);
    this.padFilter.frequency.setTargetAtTime(cut, now, 0.8);
  }

  private tick(step: number, t: number, sd: number) {
    const m = this.mood;
    if (m === 'silent') return;
    const prog = m === 'boss' ? PROG_BOSS : m === 'victory' ? PROG_MAJOR : m === 'run' ? (PROG_REGION[this.region] ?? PROG_MINOR) : PROG_MINOR;
    const s16 = step % 16;
    const bar = Math.floor(step / 16);
    const chord = prog[Math.floor(bar / 2) % 4];
    const L = this.layer;
    const I = this.intensity;
    // ---- pad: re-voice at the start of each chord
    if (step % 32 === 0 && L.pad > 0.02) {
      const dur = sd * 32;
      for (let i = 1; i < chord.length; i++) this.pad(midi(chord[i]), t, dur, 0.062 * L.pad);
      this.pad(midi(chord[0]), t, dur, 0.085 * L.pad);
    }
    // ---- bass
    if (L.bass > 0.05) {
      const pat = m === 'boss' ? [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0] : I >= 3 ? [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0] : [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
      if (pat[s16]) this.bass(midi(chord[0] + (s16 === 14 || s16 === 13 ? 7 : 0)), t, sd * 2.4, 0.24 * L.bass);
    }
    // ---- arpeggio
    if (L.arp > 0.05) {
      const dense = m === 'boss' || I >= 3;
      const every = m === 'menu' ? 4 : dense ? 1 : 2;
      if (s16 % every === 0) {
        const order = [1, 3, 2, 4, 3, 5, 4, 2];
        const idx = order[Math.floor(step / every) % order.length];
        const skip = m === 'menu' ? this.rnd() < 0.25 : this.rnd() < 0.12;
        if (!skip) this.pluck(midi(chord[idx] + 12), t, sd * 2.5, 0.09 * L.arp * (s16 % 4 === 0 ? 1.2 : 0.8));
      }
    }
    // ---- drums
    if (L.drums > 0.05) {
      const four = m === 'boss' || I >= 4;
      if (four ? s16 % 4 === 0 : s16 === 0 || s16 === 8 || s16 === 11) this.kick(t, 0.34 * L.drums);
      if ((m === 'boss' || I >= 3) && (s16 === 4 || s16 === 12)) this.snare(t, 0.14 * L.drums);
      if (s16 % 2 === 0 || m === 'boss') this.hat(t, (s16 % 4 === 2 ? 0.065 : 0.036) * L.drums);
    }
    // ---- lead: slow wandering melody on chord tones
    if (L.lead > 0.05 && (s16 === 0 || s16 === 6 || s16 === 10) && this.rnd() < 0.75) {
      this.leadNote = (this.leadNote + (this.rnd() < 0.5 ? 1 : this.rnd() < 0.5 ? -1 : 2) + 5) % 5;
      const n = chord[1 + this.leadNote] + 24;
      this.lead(midi(n), t, sd * (s16 === 0 ? 6 : 4), 0.065 * L.lead);
    }
  }

  private pad(freq: number, t: number, dur: number, vol: number) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + dur * 0.3);
    g.gain.setValueAtTime(vol, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0.0001, t + dur * 1.25);
    g.connect(this.padFilter);
    for (const det of [-9, 8]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = det;
      o.connect(g);
      o.start(t);
      o.stop(t + dur * 1.3);
    }
  }

  private bass(freq: number, t: number, dur: number, vol: number) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.out);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = freq / 2;
    o.connect(g);
    o2.connect(g);
    o.start(t);
    o2.start(t);
    o.stop(t + dur + 0.05);
    o2.stop(t + dur + 0.05);
  }

  private pluck(freq: number, t: number, dur: number, vol: number) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(3800, t);
    f.frequency.exponentialRampToValueAtTime(700, t + dur);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    o.connect(f);
    f.connect(g);
    g.connect(this.out);
    const send = ctx.createGain();
    send.gain.value = 0.55;
    g.connect(send);
    send.connect(this.delayIn);
    const r = ctx.createGain();
    r.gain.value = 0.35;
    g.connect(r);
    r.connect(this.rev);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private lead(freq: number, t: number, dur: number, vol: number) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const vib = ctx.createOscillator();
    vib.frequency.value = 5;
    const vg = ctx.createGain();
    vg.gain.value = freq * 0.006;
    vib.connect(vg);
    vg.connect(o.frequency);
    o.connect(g);
    g.connect(this.out);
    const r = ctx.createGain();
    r.gain.value = 0.9;
    g.connect(r);
    r.connect(this.rev);
    g.connect(this.delayIn);
    o.start(t);
    vib.start(t);
    o.stop(t + dur + 0.05);
    vib.stop(t + dur + 0.05);
  }

  private kick(t: number, vol: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(g);
    g.connect(this.out);
    o.start(t);
    o.stop(t + 0.3);
  }

  private nz(t: number, dur: number, vol: number, type: BiquadFilterType, freq: number) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(this.out);
    s.start(t, Math.random() * 0.5);
    s.stop(t + dur + 0.02);
    return g;
  }

  private snare(t: number, vol: number) {
    const g = this.nz(t, 0.16, vol, 'bandpass', 1900);
    const r = this.ctx.createGain();
    r.gain.value = 0.4;
    g.connect(r);
    r.connect(this.rev);
  }

  private hat(t: number, vol: number) {
    this.nz(t, 0.04, vol, 'highpass', 7500);
  }
}
