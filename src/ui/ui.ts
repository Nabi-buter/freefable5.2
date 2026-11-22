import './style.css';
import '@fontsource/cinzel/latin-700.css';
import '@fontsource/cinzel/latin-900.css';
import type { AudioEngine } from '../audio/audio';
import { ALT_SKINS, MASTERY_WINS, masteryOf, PACTS, PACT_IDS, SKILLS, SYNERGIES, SYNERGY_IDS, SYNERGY_LEVEL, type PactId, type SkillId } from '../sim/defs';
import { BIND_ACTIONS, DEFAULT_BINDS, DEFAULT_PAD, PAD_ACTIONS, isTouchPrimary, keyLabel, padLabel, type BindAction, type Input, type PadAction } from '../core/input';
import { evoHint, fmtNum, fmtTime, getLang, passiveText, setLang, t, weaponLevelText, weaponName } from '../core/i18n';
import { ACHIEVEMENTS, type RunSummary } from '../core/progress';
import type { SaveStore } from '../core/save';
import { DAILY_BONUS, dailyInfo } from '../core/daily';
import {
  CHARS, CHAR_IDS, ENEMIES, ENEMY_KINDS, EVOLVED_LEVEL, MAX_PASSIVES, MAX_WEAPONS, MAX_WEAPON_LEVEL, META, PASSIVES, PASSIVE_IDS, RELIC_COLORS, WEAPONS, WEAPON_IDS,
  metaCost, type CharId, type MetaId,
} from '../sim/defs';
import type { Sim } from '../sim/sim';
import type { Choice, Pending } from '../sim/types';
import { BEACON_COUNT, type BiomeId } from '../sim/worldgen';
import { icon } from './icons';

export interface UIHost {
  save: SaveStore;
  audio: AudioEngine;
  input: Input;
  version: string;
  startRun(daily?: boolean): void;
  resume(): void;
  abandon(): void;
  restart(): void;
  retry(): void;
  toMenu(): void;
  settingsChanged(): void;
  pauseRequest(): void;
  choose(index: number): void;
  reroll(): boolean;
  banish(index: number): boolean;
  skip(): void;
  toggleFullscreen(): void;
}

type Screen = 'none' | 'title' | 'setup' | 'shop' | 'records' | 'settings' | 'how';
type Modal = null | 'pending' | 'pause' | 'result' | 'confirm';

const BOON_LOOK: Record<string, [string, string]> = {
  blood: ['bloodember', '#ff4d5e'], ward: ['vigor', '#ff8aa0'], fury: ['might', '#ff7a3c'], swift: ['dash', '#7fd4ff'],
  tithe: ['cinder', '#ffb347'], renew: ['heart', '#7dff9b'], gamble: ['reroll', '#c6a2ff'],
  forge: ['sword', '#ffb070'], oath: ['oathbrand', '#ff4d5e'], insight: ['banish', '#7fd4ff'],
};
const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
const BIOMES: BiomeId[] = ['ashwood', 'frostmere', 'emberwaste', 'gloommire', 'stormcrag'];
const BIOME_COLOR: Record<BiomeId, string> = { ashwood: '#5fd39a', frostmere: '#9ad8ff', emberwaste: '#ff7a4a', gloommire: '#b98cff', stormcrag: '#bfe0ff' };
const BIOME_ICON: Record<BiomeId, string> = { ashwood: 'starmoss', frostmere: 'frost', emberwaste: 'ember', gloommire: 'mire', stormcrag: 'arc' };
const DIFF_COLOR = ['#ffb347', '#8fa8ff', '#ff5a5a'];
const META_ICON: Record<MetaId, string> = {
  m_hp: 'vigor', m_might: 'might', m_haste: 'haste', m_speed: 'swift', m_regen: 'mending', m_armor: 'plating', m_magnet: 'magnet', m_xp: 'wisdom',
  m_cinder: 'cinder', m_luck: 'fortune', m_skill: 'flare', m_dash: 'dash', m_shrine: 'sanctuary', m_kit: 'chest', m_reroll: 'reroll', m_banish: 'banish', m_revive: 'phoenix',
};
const META_COLOR: Record<MetaId, string> = {
  m_hp: '#ff5d6c', m_might: '#ff9a4a', m_haste: '#ffe36b', m_speed: '#8affea', m_regen: '#7dff9b', m_armor: '#b9c4d6', m_magnet: '#6bd1ff', m_xp: '#c7a2ff',
  m_cinder: '#ffb347', m_luck: '#ffd24a', m_skill: '#ffa040', m_dash: '#7fd4ff', m_shrine: '#c6a2ff', m_kit: '#ffd24a', m_reroll: '#7fd4ff', m_banish: '#ff8a80', m_revive: '#ff7a3c',
};
const ENEMY_COLOR: Record<string, string> = {
  shade: '#ff4d86', skitter: '#9dff5a', brute: '#ff8a2a', spitter: '#a6ff3a', wraith: '#6cf2ff', bomber: '#ff3a6a', husk: '#ffd24a', rime: '#8fe0ff', worm: '#ff7a2a', sporecap: '#9cff8a', thief: '#ffc04a', stormling: '#bfe0ff', shieldbearer: '#c8a060', herald: '#b04aff', eclipse: '#ff5a3c',
};

export class UI {
  private root: HTMLElement;
  private host: UIHost;
  private screenEl: HTMLElement;
  private hud: HTMLElement;
  private modalEl: HTMLElement;
  private toasts: HTMLElement;
  screen: Screen = 'none';
  modal: Modal = null;
  private settingsFrom: 'title' | 'pause' = 'title';
  /** embers available when the current choice screen opened (merchant prices) */
  private purse = 0;
  private rebinding: BindAction | null = null;
  private padRebinding: PadAction | null = null;
  private recTab: 'ach' | 'stats' | 'history' | 'codex' = 'ach';
  private focusIdx = -1;
  private openedAt = 0;
  private banishMode = false;
  private confirmYes: (() => void) | null = null;
  private confirmBack: (() => void) | null = null;
  private pendingRef: Pending | null = null;
  // hud caches
  private h: Record<string, HTMLElement> = {};
  private cache: Record<string, string | number> = {};
  private mini!: CanvasRenderingContext2D;
  private miniT = 0;
  private bannerT = 0;
  private tipT = 0;
  private tipStage = 0;
  private fpsAcc = 0;
  private fpsN = 0;
  private lastSummary: RunSummary | null = null;

  constructor(root: HTMLElement, host: UIHost) {
    this.root = root;
    this.host = host;
    root.innerHTML = `<div id="screen"></div><div id="hud" class="hidden"></div><div id="modal" class="hidden"></div><div id="toasts"></div>`;
    this.screenEl = root.querySelector('#screen')!;
    this.hud = root.querySelector('#hud')!;
    this.modalEl = root.querySelector('#modal')!;
    this.toasts = root.querySelector('#toasts')!;
    this.buildHud();
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('mouseover', (e) => {
      const el = (e.target as HTMLElement).closest('.btn, .card, .pick, .tab, .iconbtn, .hudbtn') as HTMLElement | null;
      if (el && el !== this.hoverEl) {
        this.hoverEl = el;
        this.host.audio.ui('hover');
        this.clearFocus();
      } else if (!el) this.hoverEl = null;
    });
    root.addEventListener('input', (e) => this.onInput(e));
    host.input.onDevice = (d) => document.body.classList.toggle('touch', d === 'touch');
    if (isTouchPrimary()) document.body.classList.add('touch');
  }
  private hoverEl: HTMLElement | null = null;

  // ================================================================== plumbing
  private get save() {
    return this.host.save.data;
  }

  private layer(): HTMLElement {
    return this.modal ? this.modalEl : this.screenEl;
  }

  private focusables(): HTMLElement[] {
    return Array.from(this.layer().querySelectorAll<HTMLElement>('.f')).filter((e) => !e.hasAttribute('disabled') && e.offsetParent !== null);
  }

  private clearFocus() {
    this.layer().querySelectorAll('.focus').forEach((e) => e.classList.remove('focus'));
    this.focusIdx = -1;
  }

  private setFocus(i: number) {
    const list = this.focusables();
    if (list.length === 0) return;
    this.layer().querySelectorAll('.focus').forEach((e) => e.classList.remove('focus'));
    this.focusIdx = ((i % list.length) + list.length) % list.length;
    const el = list[this.focusIdx];
    el.classList.add('focus');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.host.audio.ui('hover');
  }

  /** keyboard / gamepad navigation, driven from the main loop */
  pollInput(input: Input) {
    const active = this.modal !== null || this.screen !== 'none';
    if (!active) return;
    const nav = input.takeNav();
    const confirm = input.takeConfirm();
    const back = input.takeBack();
    const num = input.takeNumber();
    const keys = input.takeKeys();
    input.takeDash();
    input.takeSkill();
    input.takePause();
    const guard = performance.now() - this.openedAt < 320;
    if (nav !== 0) this.setFocus(this.focusIdx < 0 ? 0 : this.focusIdx + nav);
    if (this.modal === 'pending' && this.pendingRef) {
      if (guard) return;
      if (this.pendingRef.type === 'chest') {
        if (confirm) this.act('chest-ok');
        return;
      }
      if (num >= 1 && num <= this.pendingRef.choices.length) {
        this.act('choose', String(num - 1));
        return;
      }
      if (keys.includes('KeyR')) this.act('reroll');
      if (confirm) {
        const list = this.focusables();
        if (this.focusIdx >= 0 && list[this.focusIdx]) list[this.focusIdx].click();
        else this.setFocus(0);
      }
      return;
    }
    if (guard) return;
    if (confirm) {
      const list = this.focusables();
      if (this.focusIdx >= 0 && list[this.focusIdx]) list[this.focusIdx].click();
      else {
        const def = this.layer().querySelector<HTMLElement>('.f.primary');
        if (def) def.click();
        else this.setFocus(0);
      }
    }
    if (back) this.back();
  }

  private back() {
    if (this.modal === 'confirm') {
      this.confirmBack?.();
      return;
    }
    if (this.modal === 'pause') {
      this.act('resume');
      return;
    }
    if (this.modal) return;
    if (this.screen === 'settings') this.act('settings-back');
    else if (this.screen !== 'title' && this.screen !== 'none') this.act('title');
  }

  private onClick(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!el || el.hasAttribute('disabled')) return;
    this.host.audio.unlock();
    this.act(el.dataset.act!, el.dataset.arg);
  }

  private onInput(e: Event) {
    const el = e.target as HTMLInputElement;
    if (el.dataset.seed !== undefined) {
      this.save.last.seed = el.value.replace(/[^0-9]/g, '').slice(0, 10);
      if (el.value !== this.save.last.seed) el.value = this.save.last.seed;
      return;
    }
    const key = el.dataset.set;
    if (!key) return;
    const s = this.save.settings as unknown as Record<string, number>;
    s[key] = Number(el.value);
    this.host.settingsChanged();
    if (key === 'sfx' || key === 'master') this.host.audio.ui('click');
  }

  toast(text: string) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    this.toasts.appendChild(el);
    setTimeout(() => el.remove(), 2700);
  }

  private setScreen(s: Screen, html = '') {
    this.screen = s;
    this.screenEl.innerHTML = html;
    this.focusIdx = -1;
    this.openedAt = performance.now();
    this.hoverEl = null;
  }

  private setModal(m: Modal, html = '', cls = '') {
    this.modal = m;
    this.modalEl.className = m ? cls : 'hidden';
    this.modalEl.innerHTML = html;
    this.focusIdx = -1;
    this.openedAt = performance.now();
    this.hoverEl = null;
  }

  closeModal() {
    this.setModal(null);
    this.pendingRef = null;
    this.banishMode = false;
  }

  // ================================================================== actions
  private act(a: string, arg?: string) {
    const au = this.host.audio;
    const sv = this.save;
    if (this.rebinding && a !== 'rebind') {
      // leaving a pending key capture by clicking elsewhere cancels it
      this.rebinding = null;
      this.host.input.capture = null;
    }
    if (this.padRebinding && a !== 'padbind') {
      this.padRebinding = null;
      this.host.input.padCapture = null;
    }
    switch (a) {
      case 'rebind': {
        const action = arg as BindAction;
        if (!BIND_ACTIONS.includes(action)) break;
        au.ui('click');
        this.rebinding = action;
        this.showSettings(true);
        this.host.input.capture = (code) => {
          this.rebinding = null;
          if (code !== 'Escape') {
            const keys = sv.settings.keys;
            // a key can only do one thing: swap with whatever used it before
            for (const o of BIND_ACTIONS) if (o !== action && keys[o] === code) keys[o] = keys[action];
            keys[action] = code;
            this.host.settingsChanged();
            this.host.save.save();
            au.ui('select');
          } else au.ui('back');
          if (this.screen === 'settings') this.showSettings(true);
        };
        break;
      }
      case 'step': {
        const [key, dir, min, max] = (arg ?? '').split(':');
        const st = sv.settings as unknown as Record<string, number>;
        const lo = Number(min), hi = Number(max);
        const next = Math.max(lo, Math.min(hi, (Number(st[key]) || 0) + Number(dir) * (hi - lo) * 0.1));
        st[key] = Math.round(next * 100) / 100;
        au.ui('click');
        this.host.settingsChanged();
        this.host.save.save();
        this.showSettings(true);
        break;
      }
      case 'padbind': {
        const action = arg as PadAction;
        if (!PAD_ACTIONS.includes(action)) break;
        au.ui('click');
        this.padRebinding = action;
        this.showSettings(true);
        this.host.input.padCapture = (btn) => {
          this.padRebinding = null;
          const pad = sv.settings.pad;
          // swap so the two actions never share a button
          for (const o of PAD_ACTIONS) if (o !== action && pad[o] === btn) pad[o] = pad[action];
          pad[action] = btn;
          this.host.settingsChanged();
          this.host.save.save();
          au.ui('select');
          if (this.screen === 'settings') this.showSettings(true);
        };
        break;
      }
      case 'pad-reset':
        sv.settings.pad = { ...DEFAULT_PAD };
        au.ui('click');
        this.host.settingsChanged();
        this.host.save.save();
        this.showSettings(true);
        break;
      case 'keys-reset':
        sv.settings.keys = { ...DEFAULT_BINDS };
        au.ui('click');
        this.host.settingsChanged();
        this.host.save.save();
        this.showSettings(true);
        break;
      case 'title': au.ui('back'); this.showTitle(); break;
      case 'play': au.ui('click'); this.showSetup(); break;
      case 'daily': au.ui('select'); this.host.startRun(true); break;
      case 'shop': au.ui('click'); this.showShop(); break;
      case 'records': au.ui('click'); this.showRecords(); break;
      case 'how': au.ui('click'); this.showHow(); break;
      case 'settings': au.ui('click'); this.settingsFrom = 'title'; this.showSettings(); break;
      case 'pause-settings': au.ui('click'); this.settingsFrom = 'pause'; this.setModal(null); this.showSettings(); break;
      case 'settings-back':
        au.ui('back');
        this.host.save.save();
        if (this.settingsFrom === 'pause') {
          this.setScreen('none');
          this.host.pauseRequest();
        } else this.showTitle();
        break;
      case 'lang':
        sv.settings.lang = sv.settings.lang === 'ko' ? 'en' : 'ko';
        setLang(sv.settings.lang);
        this.host.save.save();
        au.ui('click');
        this.cache = {};
        if (this.screen === 'title') this.showTitle();
        else if (this.screen === 'settings') this.showSettings();
        break;
      case 'full': au.ui('click'); this.host.toggleFullscreen(); break;
      case 'toggle-pact': {
        const id = arg as PactId;
        if (!PACT_IDS.includes(id) || sv.stats.wins < 1) break;
        const i = sv.last.pacts.indexOf(id);
        if (i >= 0) sv.last.pacts.splice(i, 1);
        else sv.last.pacts.push(id);
        au.ui('click');
        this.showSetup();
        break;
      }
      case 'pick-skin': {
        const k = Number(arg);
        if (k === 1 && !((sv.stats.winsByChar[sv.last.char] ?? 0) > 0)) {
          au.ui('deny');
          this.toast(t('skin.locked'));
          break;
        }
        sv.last.skins[sv.last.char] = k === 1 ? 1 : 0;
        au.ui('click');
        this.showSetup();
        break;
      }
      case 'pick-skill': {
        const c = CHARS[sv.last.char];
        if (arg === c.skill || arg === c.alt) sv.last.skills[sv.last.char] = arg as SkillId;
        au.ui('click');
        this.showSetup();
        break;
      }
      case 'pick-char':
        sv.last.char = arg as CharId;
        au.ui('click');
        this.showSetup();
        break;
      case 'pick-biome':
        sv.last.biome = arg as BiomeId;
        au.ui('click');
        this.showSetup();
        break;
      case 'pick-mode':
        sv.last.endless = arg === 'endless';
        sv.last.trial = arg === 'trial';
        au.ui('click');
        this.showSetup();
        break;
      case 'pick-diff':
        sv.last.difficulty = Number(arg);
        au.ui('click');
        this.showSetup();
        break;
      case 'start': {
        if (!sv.chars.includes(sv.last.char) || !sv.biomes.includes(sv.last.biome) || sv.last.difficulty > sv.stats.cleared || (sv.last.endless && sv.stats.wins < 1)) {
          au.ui('deny');
          break;
        }
        au.ui('select');
        this.host.save.save();
        this.host.startRun();
        break;
      }
      case 'buy': {
        const m = META.find((x) => x.id === arg);
        if (!m) break;
        const lvl = sv.meta[m.id] ?? 0;
        const cost = metaCost(m, lvl);
        if (lvl >= m.max || sv.cinders < cost) {
          au.ui('deny');
          break;
        }
        sv.cinders -= cost;
        sv.meta[m.id] = lvl + 1;
        this.host.save.save();
        au.ui('buy');
        this.showShop(true);
        break;
      }
      case 'refund': {
        let back = 0;
        for (const m of META) {
          const lvl = sv.meta[m.id] ?? 0;
          for (let i = 0; i < lvl; i++) back += metaCost(m, i);
          sv.meta[m.id] = 0;
        }
        sv.cinders += back;
        this.host.save.save();
        au.ui('buy');
        this.showShop(true);
        break;
      }
      case 'tab': au.ui('click'); this.recTab = arg as typeof this.recTab; this.showRecords(); break;
      case 'set': {
        const [key, val] = (arg ?? '').split(':');
        const s = sv.settings as unknown as Record<string, unknown>;
        if (val === 'true' || val === 'false') s[key] = val === 'true';
        else s[key] = val;
        // picking a quality by hand turns off the automatic step-down
        if (key === 'quality') sv.settings.autoQuality = false;
        au.ui('click');
        this.host.settingsChanged();
        this.host.save.save();
        this.showSettings(true);
        break;
      }
      case 'export': {
        const code = this.host.save.export();
        navigator.clipboard?.writeText(code).then(() => this.toast(t('set.copied')), () => window.prompt('', code));
        au.ui('click');
        break;
      }
      case 'import': {
        const code = window.prompt(t('set.import.prompt'));
        if (code) {
          const ok = this.host.save.import(code);
          this.toast(t(ok ? 'set.import.ok' : 'set.import.bad'));
          if (ok) {
            setLang(this.save.settings.lang);
            this.host.settingsChanged();
            this.showSettings();
          }
        }
        break;
      }
      case 'reset':
        au.ui('click');
        this.confirm(t('set.reset.confirm'), () => {
          this.host.save.reset();
          this.closeModal();
          this.showSettings();
        }, () => this.closeModal());
        break;
      // ---- in-run
      case 'pause': this.host.pauseRequest(); break;
      case 'resume': au.ui('back'); this.closeModal(); this.host.resume(); break;
      case 'restart':
        au.ui('click');
        this.confirm(t('pause.restart.confirm'), () => this.host.restart(), () => this.host.pauseRequest());
        break;
      case 'quit':
        au.ui('click');
        this.confirm(t('pause.confirm'), () => {
          this.closeModal();
          this.host.abandon();
        }, () => this.host.pauseRequest());
        break;
      case 'choose': {
        const i = Number(arg);
        const ch = this.pendingRef?.choices[i];
        if (ch && ch.type === 'buy' && ch.cost > this.purse) {
          au.ui('deny');
          this.toast(t('merchant.poor'));
          break;
        }
        if (this.banishMode) {
          if (this.host.banish(i)) au.ui('back');
          else au.ui('deny');
          this.banishMode = false;
          return;
        }
        au.ui('select');
        this.host.choose(i);
        break;
      }
      case 'reroll':
        if (this.host.reroll()) au.ui('open');
        else au.ui('deny');
        break;
      case 'banish':
        this.banishMode = !this.banishMode;
        au.ui('click');
        this.modalEl.querySelectorAll('.card').forEach((c) => c.classList.toggle('banishing', this.banishMode));
        (this.modalEl.querySelector('.m-sub') as HTMLElement).textContent = t(this.banishMode ? 'levelup.banish.hint' : 'levelup.sub');
        break;
      case 'skip': au.ui('back'); this.host.skip(); break;
      case 'chest-ok': au.ui('select'); this.host.choose(0); break;
      case 'retry': au.ui('select'); this.closeModal(); this.host.retry(); break;
      case 'menu': au.ui('back'); this.closeModal(); this.host.toMenu(); break;
      case 'yes': au.ui('click'); this.confirmYes?.(); break;
      case 'no': au.ui('back'); this.confirmBack?.(); break;
    }
  }

  private confirm(text: string, yes: () => void, no: () => void) {
    this.confirmYes = yes;
    this.confirmBack = no;
    this.setModal('confirm', `<div class="panel confirm"><p>${text}</p><div class="pause-actions"><button class="btn f danger" data-act="yes">${t('common.yes')}</button><button class="btn f primary" data-act="no">${t('common.no')}</button></div></div>`);
  }

  // ================================================================== screens
  showTitle() {
    this.hud.classList.add('hidden');
    const sv = this.save;
    const di = dailyInfo();
    const dailyDone = sv.daily.date === di.date && sv.daily.done;
    this.setScreen('title', `
      <div class="screen title">
        <div class="logo"><div class="logo-main">CINDERWAKE</div><div class="logo-sub">${t('title.sub')}</div></div>
        ${isTouchPrimary() ? `<div class="rotate-hint">${icon('reroll', 16)}${t('title.rotate')}</div>` : ''}
        <nav class="menu">
          ${sv.stats.runs === 0 ? `<button class="first-hint f" data-act="how">${icon('book', 16)}${t('title.first')}</button>` : ''}
          <button class="btn primary f" data-act="play">${icon('ember', 22)}${t('menu.play')}</button>
          <button class="btn f daily ${dailyDone ? 'done' : ''}" data-act="daily">
            <span class="d-ic" style="color:${hex(CHARS[di.char].accent)}">${icon(di.char, 20)}</span>
            <span class="d-tx"><b>${t('menu.daily')}</b><small>${t('c.' + di.char)} · ${t('b.' + di.biome)}</small><small>${t('sk.' + di.skill)} · ${t('pact.' + di.pact)}</small></span>
            <span class="d-st">${dailyDone ? `${icon('check', 16)}${fmtTime(sv.daily.best)}` : `${icon('cinder', 14)}+${DAILY_BONUS}`}</span>
          </button>
          <button class="btn f" data-act="shop">${icon('cinder', 18)}${t('menu.upgrades')}</button>
          <div class="row">
            <button class="btn f" data-act="records">${icon('trophy', 18)}${t('menu.records')}</button>
            <button class="btn f" data-act="how">${icon('book', 18)}${t('menu.how')}</button>
          </div>
          <button class="btn ghost f" data-act="settings">${icon('gear', 18)}${t('menu.settings')}</button>
        </nav>
        <div class="title-foot">
          <span class="purse">${icon('cinder', 18)}${fmtNum(sv.cinders)}</span>
          <span>${this.host.version}</span>
          <span class="tools">
            <button class="iconbtn" data-act="lang" title="Language">${icon('globe', 20)}</button>
            <button class="iconbtn" data-act="full" title="Fullscreen">${icon('fullscreen', 20)}</button>
          </span>
        </div>
      </div>`);
  }

  private showSetup() {
    const sv = this.save;
    const c = CHARS[sv.last.char];
    const pick: SkillId = sv.last.skills[sv.last.char] ?? c.skill;
    const charOk = sv.chars.includes(sv.last.char);
    const biomeOk = sv.biomes.includes(sv.last.biome);
    const diffOk = sv.last.difficulty <= sv.stats.cleared;
    const endlessOk = sv.stats.wins > 0;
    const trial = !!sv.last.trial && !sv.last.endless;
    const endless = sv.last.endless;
    const chars = CHAR_IDS.map((id) => {
      const ok = sv.chars.includes(id);
      return `<button class="pick f ${id === sv.last.char ? 'sel' : ''} ${ok ? '' : 'locked'}" style="--c:${hex(CHARS[id].accent)}" data-act="pick-char" data-arg="${id}">
        <span class="pic">${icon(ok ? id : 'lock', 26)}</span><span class="nm">${t('c.' + id)}</span>${ok && masteryOf(sv.stats.winsByChar[id] ?? 0) ? `<span class="mstars">${'★'.repeat(masteryOf(sv.stats.winsByChar[id] ?? 0))}</span>` : ''}</button>`;
    }).join('');
    const biomes = BIOMES.map((id) => {
      const ok = sv.biomes.includes(id);
      return `<button class="pick f ${id === sv.last.biome ? 'sel' : ''} ${ok ? '' : 'locked'}" style="--c:${BIOME_COLOR[id]}" data-act="pick-biome" data-arg="${id}">
        <span class="pic">${icon(ok ? BIOME_ICON[id] : 'lock', 26)}</span><span class="nm">${t('b.' + id)}</span></button>`;
    }).join('');
    const diffs = [0, 1, 2].map((d) => {
      const ok = d <= sv.stats.cleared;
      return `<button class="pick f ${d === sv.last.difficulty ? 'sel' : ''} ${ok ? '' : 'locked'}" style="--c:${DIFF_COLOR[d]}" data-act="pick-diff" data-arg="${d}">
        <span class="pic">${icon(ok ? (d === 0 ? 'star' : d === 1 ? 'skull' : 'crown') : 'lock', 26)}</span><span class="nm">${t('d.' + d)}</span></button>`;
    }).join('');
    const lock = (key: string) => `<p class="lockmsg">${icon('lock', 18)}${t(key)}</p>`;
    const best = sv.stats.bestTime[sv.last.difficulty];
    this.setScreen('setup', `
      <div class="screen shade">
        <div class="head"><h1>${t('setup.title')}</h1><span class="purse">${icon('cinder', 18)}${fmtNum(sv.cinders)}</span></div>
        <div class="setup-body">
          <div class="setup-col">
            <div><div class="group-label">${t('setup.char')}</div><div class="pick-grid eight">${chars}</div></div>
            <div class="panel detail">
              <h2 style="color:${hex(c.accent)}">${icon(sv.last.char, 30)}<span style="color:var(--text)">${t('c.' + sv.last.char)}</span>${charOk ? `<span class="skins">${[0, 1].map((k) => { const ok = k === 0 || (sv.stats.winsByChar[sv.last.char] ?? 0) > 0; const col = k === 0 ? [c.cloak, c.accent] : ALT_SKINS[sv.last.char]; return `<button class="skin f ${(sv.last.skins[sv.last.char] ?? 0) === k ? 'on' : ''} ${ok ? '' : 'locked'}" style="--sk1:${hex(col[0])};--sk2:${hex(col[1])}" data-act="pick-skin" data-arg="${k}" title="${ok ? '' : t('skin.locked')}">${ok ? '' : icon('lock', 12)}</button>`; }).join('')}</span>` : ''}</h2>
              <p>${t(`c.${sv.last.char}.d`)}</p>
              ${charOk ? '' : lock(`c.${sv.last.char}.u`)}
              <div class="statline">
                <span class="k">${t('setup.weapon')}</span><span class="v" style="color:${hex(WEAPONS[c.weapon].color)}">${icon(c.weapon, 20)}<span style="color:var(--text)">${t('w.' + c.weapon)}</span></span>
                <span class="k">${t('setup.hp')}</span><span class="v"><span class="meter"><i style="width:${(c.hp / 140) * 100}%"></i></span>${c.hp}</span>
                <span class="k">${t('setup.speed')}</span><span class="v"><span class="meter"><i style="width:${((c.speed - 5.5) / 2.6) * 100}%"></i></span>${c.speed.toFixed(1)}</span>
                <span class="k">${t('setup.trait')}</span><span class="v">${t(`c.${sv.last.char}.t`)}</span>
                <span class="k">${t('setup.mastery')}</span><span class="v mast">${(() => { const w = sv.stats.winsByChar[sv.last.char] ?? 0; const m = masteryOf(w); return `<b>${'★'.repeat(m)}${'☆'.repeat(3 - m)}</b> <small>${m < 3 ? t('setup.mastery.next', MASTERY_WINS[m] - w) : t('setup.mastery.max')}</small>`; })()}</span>
                <span class="k">${t('setup.skill')}</span><span class="v sk" style="--c:${hex(SKILLS[pick].color)}"><span class="skpick">${[c.skill, c.alt].map((id) => `<button class="f ${id === pick ? 'on' : ''}" style="--c:${hex(SKILLS[id].color)}" data-act="pick-skill" data-arg="${id}">${icon(id, 15)}${t('sk.' + id)}</button>`).join('')}</span>${t('sk.cd', SKILLS[pick].cd)}<small>${t(`sk.${pick}.d`)}</small><small style="color:var(--gold)">${t('sk.awake')}</small></span>
              </div>
            </div>
          </div>
          <div class="setup-col">
            <div><div class="group-label">${t('setup.stage')}</div><div class="pick-grid five">${biomes}</div></div>
            <div class="panel detail slim"><p>${t(`b.${sv.last.biome}.d`)}</p>${biomeOk ? '' : lock(`b.${sv.last.biome}.u`)}</div>
            <div><div class="group-label">${t('setup.diff')}</div><div class="pick-grid three">${diffs}</div></div>
            <div class="panel detail slim"><p>${t(`d.${sv.last.difficulty}.d`)}</p>${diffOk ? (best ? `<p>${icon('clock', 16)} ${t('rec.best', t('d.' + sv.last.difficulty))}: <b style="color:var(--amber-hot)">${fmtTime(best)}</b></p>` : '') : lock(`d.${sv.last.difficulty}.u`)}</div>
            <div><div class="group-label">${t('setup.mode')}</div><div class="pick-grid three">
              <button class="pick row f ${endless || trial ? '' : 'sel'}" style="--c:#ffb347" data-act="pick-mode" data-arg="dawn"><span class="pic">${icon('wideglow', 22)}</span><span class="nm">${t('mode.dawn')}</span></button>
              <button class="pick row f ${endless ? 'sel' : ''} ${endlessOk ? '' : 'locked'}" style="--c:#b98cff" data-act="pick-mode" data-arg="endless"><span class="pic">${icon(endlessOk ? 'reroll' : 'lock', 22)}</span><span class="nm">${t('mode.endless')}</span></button>
              <button class="pick row f ${trial ? 'sel' : ''} ${endlessOk ? '' : 'locked'}" style="--c:#ff7a3c" data-act="pick-mode" data-arg="trial"><span class="pic">${icon(endlessOk ? 'crown' : 'lock', 22)}</span><span class="nm">${t('mode.trial')}</span></button>
            </div></div>
            <div class="panel detail slim"><p>${t(trial ? 'mode.trial.d' : endless ? 'mode.endless.d' : 'mode.dawn.d')}</p>${(endless || trial) && !endlessOk ? lock('mode.endless.u') : ''}${trial && sv.stats.bestTrial ? `<p>${icon('clock', 16)} ${t('mode.trial.best')}: <b style="color:var(--amber-hot)">${fmtTime(sv.stats.bestTrial)}</b></p>` : ''}${endless && endlessOk && sv.stats.bestLoops > 0 ? `<p>${icon('trophy', 16)} ${t('rec.loops')}: <b style="color:var(--amber-hot)">${sv.stats.bestLoops}</b></p>` : ''}</div>
            <div class="seed-row"><span class="group-label">${t('setup.seed')}</span><input class="seed-in" data-seed inputmode="numeric" maxlength="10" placeholder="${t('setup.seed.random')}" value="${sv.last.seed}"></div>
            <div><div class="group-label">${t('setup.pacts')}${sv.stats.wins > 0 ? ` <span class="pact-mul">${icon('cinder', 12)} ×${(1 + sv.last.pacts.reduce((a, id) => a + PACTS[id].reward, 0)).toFixed(2)}</span>` : ''}</div>
              ${sv.stats.wins > 0 ? `<div class="pacts">${PACT_IDS.map((id) => `<button class="pact f ${sv.last.pacts.includes(id) ? 'on' : ''}" style="--c:${hex(PACTS[id].color)}" data-act="toggle-pact" data-arg="${id}" title="${t(`pact.${id}.d`)}"><b>${t('pact.' + id)}</b><small>${t(`pact.${id}.d`)} · +${Math.round(PACTS[id].reward * 100)}%</small></button>`).join('')}</div>` : `<div class="panel detail slim">${lock('mode.endless.u')}</div>`}
            </div>
          </div>
        </div>
        <div class="foot">
          <button class="btn ghost f" data-act="title">${t('common.back')}</button>
          <button class="btn primary f" data-act="start" ${charOk && biomeOk && diffOk && (!endless || endlessOk) ? '' : 'disabled'}>${icon('ember', 22)}${t('common.start')}</button>
        </div>
      </div>`);
  }

  private showShop(keepScroll = false) {
    const sv = this.save;
    const prev = keepScroll ? (this.screenEl.querySelector('.scroll')?.scrollTop ?? 0) : 0;
    let spent = 0;
    const cards = META.map((m) => {
      const lvl = sv.meta[m.id] ?? 0;
      for (let i = 0; i < lvl; i++) spent += metaCost(m, i);
      const maxed = lvl >= m.max;
      const cost = metaCost(m, lvl);
      const pips = Array.from({ length: m.max }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
      const val = Math.round(m.per * Math.max(1, lvl + (maxed ? 0 : 1)) * 100) / 100;
      return `<div class="mcard ${maxed ? 'maxed' : ''}" style="--c:${META_COLOR[m.id]}">
        <span class="pic">${icon(META_ICON[m.id], 24)}</span>
        <div class="body"><div class="nm">${t('m.' + m.id)}</div><div class="ds">${t(`m.${m.id}.d`, val)}</div><div class="pips">${pips}</div>
          <button class="btn small buy f ${!maxed && sv.cinders >= cost ? 'primary' : ''}" data-act="buy" data-arg="${m.id}" ${maxed ? 'disabled' : ''}>${maxed ? t('common.max') : `${icon('cinder', 15)}${fmtNum(cost)}`}</button>
        </div></div>`;
    }).join('');
    this.setScreen('shop', `
      <div class="screen shade">
        <div class="head"><h1>${t('shop.title')}<span class="sub">${t('shop.sub')}</span></h1><span class="purse">${icon('cinder', 18)}${fmtNum(sv.cinders)}</span></div>
        <div class="grid-body scroll"><div class="cards">${cards}</div></div>
        <div class="foot"><button class="btn ghost f" data-act="title">${t('common.back')}</button>
          <button class="btn ghost f" data-act="refund" ${spent > 0 ? '' : 'disabled'}>${icon('reroll', 16)}${t('shop.refund')} <span class="n">+${fmtNum(spent)}</span></button></div>
      </div>`);
    if (keepScroll) this.screenEl.querySelector('.scroll')!.scrollTop = prev;
  }

  private showRecords() {
    const sv = this.save;
    const st = sv.stats;
    let body = '';
    if (this.recTab === 'ach') {
      body = `<div class="cards">${ACHIEVEMENTS.map((a) => {
        const done = !!sv.achievements[a.id];
        return `<div class="mcard ${done ? 'done' : 'undone'}" style="--c:${done ? '#ffd24a' : '#6d7396'}"><span class="pic">${icon(done ? 'trophy' : 'lock', 22)}</span>
          <div class="body"><div class="nm">${t('a.' + a.id)}</div><div class="ds">${t(`a.${a.id}.d`)}</div><div class="reward">${icon('cinder', 13)}${a.reward}</div></div></div>`;
      }).join('')}</div>`;
    } else if (this.recTab === 'history') {
      const hs = sv.history;
      body = hs.length === 0 ? `<p class="hist-empty">${t('rec.history.none')}</p>` : `<div class="history">${hs.map((r) => {
        const c = CHARS[r.char];
        const when = new Date(r.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + new Date(r.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const tags = [t('d.' + r.difficulty), r.endless ? `∞ ${r.loops}` : '', r.daily ? t('menu.daily') : '', r.pacts ? `${t('setup.pacts')} ${r.pacts}` : ''].filter(Boolean).join(' · ');
        const ws = r.weapons.map((w) => `<span class="slot small ${w.endsWith('*') ? 'evo' : ''}" style="--c:${hex(WEAPONS[w.replace('*', '') as keyof typeof WEAPONS].color)}">${icon(w.replace('*', ''), 16)}</span>`).join('');
        return `<div class="hrow ${r.win ? 'win' : 'loss'}">
          <span class="hres">${r.win ? icon('crown', 18) : icon('skull', 18)}</span>
          <span class="hchar" style="color:${hex(c.accent)}">${icon(r.char, 22)}</span>
          <span class="hmain"><b>${t('c.' + r.char)} · ${t('b.' + r.biome)}</b><small>${tags}</small></span>
          <span class="hw">${ws}</span>
          <span class="hnum"><b>${fmtTime(r.time)}</b><small>Lv ${r.level} · ${fmtNum(r.kills)}</small></span>
          <span class="hwhen">${when}</span>
        </div>`;
      }).join('')}</div>`;
    } else if (this.recTab === 'stats') {
      const row = (k: string, v: string) => `<div class="statrow"><span>${k}</span><b>${v}</b></div>`;
      body = `<div class="statlist">
        ${row(t('rec.runs'), fmtNum(st.runs))}${row(t('rec.wins'), fmtNum(st.wins))}${row(t('rec.kills'), fmtNum(st.kills))}${row(t('rec.elites'), fmtNum(st.eliteKills))}
        ${row(t('rec.beacons'), fmtNum(st.beacons))}${row(t('rec.time'), fmtTime(st.time))}${row(t('rec.maxlevel'), String(st.maxLevel))}${row(t('rec.maxcombo'), fmtNum(st.maxCombo))}
        ${row(t('rec.cinders'), fmtNum(st.cindersEarned))}${row(t('rec.loops'), st.bestLoops ? `${st.bestLoops} · ${fmtTime(st.bestEndlessTime)}` : '—')}${row(t('mode.trial.best'), st.bestTrial ? fmtTime(st.bestTrial) : '—')}
        ${[0, 1, 2].map((d) => row(t('rec.best', t('d.' + d)), st.bestTime[d] ? fmtTime(st.bestTime[d]) : '—')).join('')}
      </div>
      <div class="set-sec">${t('rec.bychar')}</div>
      <div class="statlist">${CHAR_IDS.map((c) => row(`${icon(c, 14)} ${t('c.' + c)}`, sv.chars.includes(c) ? fmtNum(st.winsByChar[c] ?? 0) : '🔒')).join('')}</div>
      <div class="set-sec">${t('rec.bybiome')}</div>
      <div class="statlist">${BIOMES.map((b) => row(`${icon(BIOME_ICON[b], 14)} ${t('b.' + b)}`, sv.biomes.includes(b) ? fmtNum(st.winsByBiome[b] ?? 0) : '🔒')).join('')}</div>`;
    } else {
      const item = (ic: string, color: string, name: string, desc: string, extra = '') => `<div class="mcard" style="--c:${color}"><span class="pic">${icon(ic, 22)}</span><div class="body"><div class="nm">${name}</div><div class="ds">${desc}</div>${extra}</div></div>`;
      const sec = (label: string) => `<div class="set-sec" style="grid-column:1/-1">${label}</div>`;
      body = `<div class="codex">
        ${sec(t('tag.weapon'))}${WEAPON_IDS.map((id) => item(id, hex(WEAPONS[id].color), t('w.' + id), t(`w.${id}.d`), `<div class="reward">${icon('up', 12)}${t(`w.${id}.e`)} — ${t('p.' + WEAPONS[id].evo)}</div>`)).join('')}
        ${sec(t('tag.passive'))}${PASSIVE_IDS.map((id) => item(id, hex(PASSIVES[id].color), t('p.' + id), passiveText(id, 1))).join('')}
        ${sec(t('tag.relic'))}${(Object.keys(RELIC_COLORS) as (keyof typeof RELIC_COLORS)[]).map((id) => item(id, hex(RELIC_COLORS[id]), t('r.' + id), t(`r.${id}.d`))).join('')}
        ${sec(t('setup.stage'))}${BIOMES.map((b) => item(BIOME_ICON[b], BIOME_COLOR[b], t('b.' + b), sv.biomes.includes(b) ? t(`b.${b}.d`) : t(`b.${b}.u`))).join('')}
        ${sec(t('shrine.title'))}${Object.keys(BOON_LOOK).map((id) => item(BOON_LOOK[id][0], BOON_LOOK[id][1], t('boon.' + id), t(`boon.${id}.d`))).join('')}
        ${sec(t('codex.lore') + ` · ${sv.lore.length}/${BIOMES.length * 5}`)}${BIOMES.map((b) => `<div class="mcard lore-card" style="--c:${BIOME_COLOR[b]};grid-column:1/-1"><span class="pic">${icon(BIOME_ICON[b], 22)}</span><div class="body"><div class="nm">${t('b.' + b)}</div>${[1, 2, 3, 4, 5].map((n) => `<div class="ds">${sv.lore.includes(`${b}.${n}`) ? t(`lore.${b}.${n}`) : '· · ·'}</div>`).join('')}</div></div>`).join('')}
        ${sec(t('codex.omens'))}${(['golden', 'deepdark', 'starfall'] as const).map((id) => item(id === 'golden' ? 'cinder' : id === 'deepdark' ? 'skull' : 'starfall', id === 'golden' ? '#ffd24a' : id === 'deepdark' ? '#ff8aa0' : '#ffe08a', t(`omen.${id}.short`), t('omen.' + id))).join('')}
        ${sec(t('syn.title'))}${SYNERGY_IDS.map((id) => item(SYNERGIES[id].a, hex(SYNERGIES[id].color), t('syn.' + id), t(`syn.${id}.d`))).join('')}
        ${sec(t('setup.skill'))}${CHAR_IDS.flatMap((id) => [CHARS[id].skill, CHARS[id].alt].map((sid) => { const sk = SKILLS[sid]; return item(sk.id, hex(sk.color), t('sk.' + sk.id), t(`sk.${sk.id}.d`), `<div class="reward" style="color:var(--mute)">${icon(id, 12)}${t('c.' + id)} · ${t('sk.cd', sk.cd)}</div>`); })).join('')}
        ${sec(t('hud.kills'))}${ENEMY_KINDS.map((id) => item('skull', ENEMY_COLOR[id], t('e.' + id), t(`e.${id}.d`), `<div class="reward" style="color:var(--mute)">${icon('heart', 12)}${ENEMIES[id].hp}</div>`)).join('')}
      </div>`;
    }
    const tab = (id: string, label: string) => `<button class="tab f ${this.recTab === id ? 'on' : ''}" data-act="tab" data-arg="${id}">${label}</button>`;
    const doneN = ACHIEVEMENTS.filter((a) => sv.achievements[a.id]).length;
    this.setScreen('records', `
      <div class="screen shade">
        <div class="head"><h1>${t('rec.title')}</h1><span class="purse">${icon('trophy', 18)}${doneN}/${ACHIEVEMENTS.length}</span></div>
        <div class="tabs">${tab('ach', t('rec.ach'))}${tab('stats', t('rec.stats'))}${tab('history', t('rec.history'))}${tab('codex', t('rec.codex'))}</div>
        <div class="grid-body scroll">${body}</div>
        <div class="foot"><button class="btn ghost f" data-act="title">${t('common.back')}</button></div>
      </div>`);
  }

  private showSettings(keepScroll = false) {
    const s = this.save.settings;
    const prev = keepScroll ? (this.screenEl.querySelector('.scroll')?.scrollTop ?? 0) : 0;
    const seg = (key: string, opts: [string, string][], cur: string) => `<div class="seg">${opts.map(([v, l]) => `<button class="f ${cur === v ? 'on' : ''}" data-act="set" data-arg="${key}:${v}">${l}</button>`).join('')}</div>`;
    // sliders get step buttons on both sides so a gamepad or keyboard can change them too
    const range = (key: string, v: number, min = 0, max = 1, step = 0.05) => `<span class="rng"><button class="stepbtn f" data-act="step" data-arg="${key}:-1:${min}:${max}" aria-label="-">−</button><input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-set="${key}"><button class="stepbtn f" data-act="step" data-arg="${key}:1:${min}:${max}" aria-label="+">+</button></span>`;
    const keepFocus = keepScroll ? this.focusIdx : -1;
    const row = (label: string, ctl: string) => `<div class="set-row"><label>${label}</label>${ctl}</div>`;
    const onoff: [string, string][] = [['true', t('common.on')], ['false', t('common.off')]];
    this.setScreen('settings', `
      <div class="screen shade">
        <div class="head"><h1>${t('menu.settings')}</h1></div>
        <div class="set-body scroll">
          <div class="set-sec">${t('set.sec.game')}</div>
          ${row(t('set.lang'), seg('lang', [['ko', '한국어'], ['en', 'English']], s.lang))}
          ${row(t('set.aim'), seg('autoAim', [['false', t('set.aim.manual')], ['true', t('set.aim.auto')]], String(s.autoAim)))}
          ${row(t('set.dmg'), seg('damageNumbers', onoff, String(s.damageNumbers)))}
          ${row(t('set.shake'), range('shake', s.shake, 0, 1.5))}
          ${row(t('set.zoom'), range('zoom', s.zoom, 0.75, 1.3))}
          <div class="set-sec">${t('set.sec.access')}</div>
          ${row(t('set.uiscale'), range('uiScale', s.uiScale, 0.8, 1.3))}
          ${row(t('set.flash'), seg('reduceFlash', onoff, String(s.reduceFlash)))}
          ${row(t('set.assist'), seg('colorAssist', onoff, String(s.colorAssist)))}
          ${row(t('set.rumble'), seg('rumble', onoff, String(s.rumble)))}
          ${isTouchPrimary() ? '' : `<div class="set-sec">${t('set.sec.keys')}</div>
          ${BIND_ACTIONS.map((a) => row(t(`set.key.${a}`), `<button class="keycap f ${this.rebinding === a ? 'wait' : ''}" data-act="rebind" data-arg="${a}">${this.rebinding === a ? t('set.key.press') : keyLabel(s.keys[a])}</button>`)).join('')}
          <div class="set-note">${t('set.key.note')}<button class="btn small ghost f" data-act="keys-reset">${t('set.key.reset')}</button></div>`}
          <div class="set-sec">${t('set.sec.pad')}</div>
          ${PAD_ACTIONS.map((a) => row(t(`set.key.${a}`), `<button class="keycap f ${this.padRebinding === a ? 'wait' : ''}" data-act="padbind" data-arg="${a}">${this.padRebinding === a ? t('set.pad.press') : padLabel(s.pad[a])}</button>`)).join('')}
          <div class="set-note">${t('set.pad.note')}<button class="btn small ghost f" data-act="pad-reset">${t('set.key.reset')}</button></div>
          <div class="set-sec">${t('set.sec.video')}</div>
          ${row(t('set.quality'), seg('quality', [['low', t('set.q.low')], ['medium', t('set.q.medium')], ['high', t('set.q.high')], ['ultra', t('set.q.ultra')]], s.quality))}
          ${row(t('set.full'), `<button class="btn small f" data-act="full">${icon('fullscreen', 16)}${t('set.full')}</button>`)}
          ${row(t('set.fps'), seg('showFps', onoff, String(s.showFps)))}
          <div class="set-sec">${t('set.sec.audio')}</div>
          ${row(t('set.master'), range('master', s.master))}
          ${row(t('set.music'), range('music', s.music))}
          ${row(t('set.sfx'), range('sfx', s.sfx))}
          <div class="set-sec">${t('set.sec.about')}</div>
          <div class="about">CINDERWAKE ${this.host.version}<br>${t('set.about.body')}<br><small>three.js (MIT) · Vite (MIT) · Cinzel font © Natanael Gama (SIL Open Font License 1.1)</small></div>
          ${this.settingsFrom === 'title' ? `<div class="set-sec">${t('set.sec.data')}</div>
          ${row(t('set.export'), `<button class="btn small f" data-act="export">${t('set.export')}</button>`)}
          ${row(t('set.import'), `<button class="btn small f" data-act="import">${t('set.import')}</button>`)}
          ${row(t('set.reset'), `<button class="btn small danger f" data-act="reset">${t('set.reset')}</button>`)}` : ''}
        </div>
        <div class="foot"><button class="btn ghost f" data-act="settings-back">${t('common.back')}</button></div>
      </div>`);
    if (keepScroll) this.screenEl.querySelector('.scroll')!.scrollTop = prev;
    if (keepFocus >= 0) {
      // re-rendering must not throw away the gamepad / keyboard cursor
      const list = this.focusables();
      if (list[keepFocus]) {
        this.focusIdx = keepFocus;
        list[keepFocus].classList.add('focus');
      }
    }
  }

  /** the four movement keys as one short label, e.g. "WASD" */
  private moveKeys(): string {
    const k = this.save.settings.keys;
    const l = [k.up, k.left, k.down, k.right].map(keyLabel);
    return l.every((x) => x.length === 1) ? l.join('') : l.join(' ');
  }

  private showHow() {
    const card = (n: number, ic: string) => `<div class="how-card"><h3>${icon(ic, 22)}${t(`how.${n}.t`)}</h3><p>${t(`how.${n}.d`)}</p></div>`;
    this.setScreen('how', `
      <div class="screen shade">
        <div class="head"><h1>${t('how.title')}</h1></div>
        <div class="grid-body scroll"><div class="how-grid">
          ${card(1, 'glasslantern')}${card(2, 'beacon')}${card(3, 'up')}${card(4, 'crown')}${card(5, 'flare')}${card(6, 'resonance')}${card(7, 'sanctuary')}${card(8, 'oathbrand')}
          <div class="how-card wide"><h3>${icon('info', 22)}${t('how.controls')}</h3><ul><li>${t('how.c.kbm', this.moveKeys(), keyLabel(this.save.settings.keys.dash))}</li><li>${t('how.c.pad')}</li><li>${t('how.c.skill', keyLabel(this.save.settings.keys.skill))}</li><li>${t('how.c.touch')}</li></ul></div>
        </div></div>
        <div class="foot"><button class="btn ghost f" data-act="title">${t('common.back')}</button><button class="btn primary f" data-act="play">${t('menu.play')}</button></div>
      </div>`);
  }

  // ================================================================== HUD
  private buildHud() {
    this.hud.innerHTML = `
      <div class="xp"><i></i></div>
      <div class="tl">
        <div class="hpwrap"><div class="lvl"><small>LV</small><b data-h="lvl">1</b></div><div class="hp" data-h="hp"><div class="lag" data-h="hplag"></div><div class="fill" data-h="hpfill"></div><span data-h="hptext"></span></div></div>
        <div class="act-row"><div class="skill" data-h="skill"><span data-h="skic"></span><i data-h="skcd"></i><b data-h="sknum"></b><small data-h="skkey"></small></div><div class="dashes" data-h="dashes"></div></div>
        <div class="slots" data-h="weapons"></div>
        <div class="slots" data-h="passives"></div>
        <div class="slots" data-h="relics"></div>
      </div>
      <div class="tc">
        <div class="timer" data-h="timer">00:00</div>
        <div class="beacons" data-h="beacons"></div>
        <div class="objective" data-h="obj"></div>
        <div class="omen" data-h="omen"></div>
        <div class="bossbar hidden" data-h="boss"><div class="nm" data-h="bossname"></div><div class="bar"><i data-h="bossfill"></i><em style="left:62%"></em><em style="left:30%"></em></div></div>
      </div>
      <div class="tr">
        <div class="counters">
          <div class="counter" data-h="killsWrap">${icon('skull', 16)}<span data-h="kills">0</span></div>
          <div class="counter gold" data-h="cindersWrap">${icon('cinder', 16)}<span data-h="cinders">0</span></div>
        </div>
        <button class="hudbtn" data-act="pause">${icon('pause', 20)}</button>
      </div>
      <div class="combo" data-h="combo"><b data-h="combon">0</b><small>${'COMBO'}</small></div>
      <div class="banner"><div class="line" data-h="banner"></div></div>
      <div class="cine" data-h="cine"></div>
      <div class="tipline" data-h="tip"></div>
      <div class="lore" data-h="lore"></div>
      <div class="minimap"><canvas width="190" height="190" data-h="mini"></canvas></div>
      <div class="stick" data-h="stick"><i data-h="knob"></i></div>
      <button class="dashbtn" data-h="dashbtn">${icon('dash', 34)}</button>
      <button class="skillbtn" data-h="skillbtn"><span data-h="skbic"></span><i data-h="skbcd"></i></button>
      <div class="fps hidden" data-h="fps"></div>`;
    this.hud.querySelectorAll<HTMLElement>('[data-h]').forEach((e) => (this.h[e.dataset.h!] = e));
    this.h.xp = this.hud.querySelector('.xp i')!;
    this.mini = (this.h.mini as HTMLCanvasElement).getContext('2d')!;
    const dash = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.host.input.requestDash();
    };
    this.h.dashbtn.addEventListener('touchstart', dash, { passive: false });
    this.h.dashbtn.addEventListener('mousedown', dash);
    const skill = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.host.input.requestSkill();
    };
    this.h.skillbtn.addEventListener('touchstart', skill, { passive: false });
    this.h.skillbtn.addEventListener('mousedown', skill);
  }

  showHud() {
    this.setScreen('none');
    this.closeModal();
    this.hud.classList.remove('hidden', 'fade');
    this.cache = {};
    this.h.banner.className = 'line';
    this.h.cine.className = 'cine';
    this.h.cine.innerHTML = '';
    this.h.tip.classList.remove('on');
    this.tipT = 0;
    this.tipStage = 0;
    this.lastSummary = null;
  }

  hideHud() {
    this.hud.classList.add('hidden');
    this.hud.classList.remove('fade');
  }

  /** fade the HUD away for the ending cinematics */
  fadeHud() {
    this.hud.classList.add('fade');
  }

  private set(key: string, val: string | number, fn: (el: HTMLElement, v: string | number) => void) {
    if (this.cache[key] === val) return false;
    this.cache[key] = val;
    fn(this.h[key] ?? this.hud, val);
    return true;
  }

  /** letterboxed title card for a boss arrival */
  bossCard(kind: string, dur: number) {
    const el = this.h.cine;
    el.style.setProperty('--d', dur + 's');
    el.innerHTML = `<div class="bar top"></div><div class="bar bot"></div><div class="who ${kind}"><small>${t(`boss.${kind}.sub`)}</small><b>${t('boss.' + kind)}</b></div>`;
    el.className = 'cine';
    void el.offsetWidth;
    el.className = 'cine on';
    this.h.banner.className = 'line';
  }

  /** a line of the island's story, shown softly for a few seconds */
  lore(key: string) {
    // wait until any choice screen has closed (shown from updateHud)
    this.pendingLore = key;
  }
  private pendingLore = '';
  private showLore(key: string) {
    const el = this.h.lore;
    if (!el) return;
    el.textContent = t(key);
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
    clearTimeout(this.loreT);
    this.loreT = window.setTimeout(() => el.classList.remove('on'), 7000);
  }
  private loreT = 0;

  announce(key: string, tone: 'info' | 'warn' | 'good') {
    const el = this.h.banner;
    el.textContent = t(key);
    el.className = 'line';
    void el.offsetWidth;
    el.className = 'line show ' + tone;
    this.bannerT = 3.2;
  }

  updateHud(sim: Sim, dt: number, fps: number) {
    if (this.pendingLore && this.modal === null && sim.pending.length === 0) {
      const k = this.pendingLore;
      this.pendingLore = '';
      this.showLore(k);
    }
    const p = sim.player;
    const st = p.st;
    // xp
    this.set('xpw', Math.round((p.xp / p.xpNext) * 1000), (_, v) => (this.h.xp.style.width = Number(v) / 10 + '%'));
    this.set('lvl', p.level, (el, v) => (el.textContent = String(v)));
    // hp
    const hpf = Math.max(0, p.hp / st.maxHp);
    this.set('hpw', Math.round(hpf * 500), () => {
      this.h.hpfill.style.width = hpf * 100 + '%';
      this.h.hplag.style.width = hpf * 100 + '%';
    });
    this.set('hptext', `${Math.ceil(p.hp)} / ${st.maxHp}`, (el, v) => (el.textContent = String(v)));
    this.set('hplow', hpf < 0.3 ? 1 : 0, (_, v) => this.h.hp.classList.toggle('low', v === 1));
    // dash pips
    const dashKey = st.dashMax + ':' + p.dashCharges + ':' + Math.round((p.dashCdT / st.dashCd) * 20);
    this.set('dashes', dashKey, (el) => {
      let html = icon('dash', 14);
      for (let i = 0; i < st.dashMax; i++) {
        const f = i < p.dashCharges ? 1 : i === p.dashCharges ? p.dashCdT / st.dashCd : 0;
        html += `<span class="pip"><i style="width:${f * 100}%"></i></span>`;
      }
      el.innerHTML = html;
      this.h.dashbtn.classList.toggle('empty', p.dashCharges === 0);
    });
    // omen chip
    const om = sim.omen;
    this.set('omen', om ? om.id + ':' + Math.ceil(om.t) : '', (el, v) => {
      el.classList.toggle('on', v !== '');
      if (om) {
        el.className = 'omen on ' + om.id;
        el.textContent = `${t('omen.' + om.id + '.short')} · ${Math.ceil(om.t)}s`;
      }
    });
    // signature ability
    const sk = SKILLS[sim.skill];
    this.set('skid', sk.id, () => {
      const col = hex(sk.color);
      this.h.skic.innerHTML = icon(sk.id, 20);
      this.h.skbic.innerHTML = icon(sk.id, 30);
      this.h.skill.style.setProperty('--c', col);
      this.h.skillbtn.style.setProperty('--c', col);
    });
    const skf = p.skillCd > 0 ? Math.min(1, p.skillCd / sim.skillCooldown()) : 0;
    this.set('skf', Math.round(skf * 60), () => {
      const deg = (skf * 360).toFixed(0) + 'deg';
      this.h.skcd.style.setProperty('--f', deg);
      this.h.skbcd.style.setProperty('--f', deg);
    });
    this.set('sknum', p.skillCd > 0 ? Math.ceil(p.skillCd) : 0, (_, v) => {
      this.h.sknum.textContent = v ? String(v) : '';
      this.h.skill.classList.toggle('ready', !v);
      this.h.skillbtn.classList.toggle('ready', !v);
    });
    this.set('skon', p.skillT > 0 ? 1 : 0, (_, v) => this.h.skill.classList.toggle('active', v === 1));
    this.set('skaw', sim.awakened() ? 1 : 0, (_, v) => { this.h.skill.classList.toggle('awake', v === 1); this.h.skillbtn.classList.toggle('awake', v === 1); });
    const dev = this.host.input.device;
    this.set('skkey', dev === 'gamepad' ? padLabel(this.save.settings.pad.skill) : dev === 'touch' ? '' : keyLabel(this.save.settings.keys.skill), (el, v) => (el.textContent = String(v)));
    // build icons
    const wKey = p.weapons.map((w) => w.id + w.level).join(',');
    this.set('weapons', wKey, (el) => {
      let html = '';
      for (let i = 0; i < MAX_WEAPONS; i++) {
        const w = p.weapons[i];
        html += w ? `<span class="slot ${w.level >= EVOLVED_LEVEL ? 'evo' : ''}" style="--c:${hex(WEAPONS[w.id].color)}">${icon(w.id, 22)}<b>${w.level >= EVOLVED_LEVEL ? '★' : w.level}</b></span>` : `<span class="slot empty"></span>`;
      }
      el.innerHTML = html;
    });
    this.set('relics', p.relics.join(','), (el) => {
      el.innerHTML = p.relics.map((r) => `<span class="slot small relic" style="--c:${hex(RELIC_COLORS[r])}">${icon(r, 16)}</span>`).join('');
    });
    const pKey = p.passives.map((w) => w.id + w.level).join(',');
    this.set('passives', pKey, (el) => {
      let html = '';
      for (let i = 0; i < MAX_PASSIVES; i++) {
        const w = p.passives[i];
        html += w ? `<span class="slot small" style="--c:${hex(PASSIVES[w.id].color)}">${icon(w.id, 16)}<b>${w.level}</b></span>` : `<span class="slot small empty"></span>`;
      }
      el.innerHTML = html;
    });
    // timer + beacons + objective
    this.set('timer', fmtTime(sim.time), (el, v) => (el.textContent = String(v)));
    let chan = -1;
    let bKey = '';
    sim.beacons.forEach((b, i) => {
      if (b.channeling) chan = i;
      bKey += b.lit ? 'L' : b.channeling ? 'C' : '-';
    });
    this.set('beacons', bKey, (el) => {
      el.innerHTML = sim.beacons.map((b) => `<i class="${b.lit ? 'lit' : b.channeling ? 'act' : ''}">${icon('beacon', 18)}</i>`).join('');
    });
    let obj: string;
    let herald = false;
    for (const g of sim.bigs) if (g.alive && g.kind === 'herald') herald = true;
    if (sim.stats.bossKilled) obj = t('obj.dawn');
    else if (sim.boss) obj = t('obj.boss');
    else if (sim.bossT >= 0) obj = t('obj.bosswait');
    else if (herald) obj = t('obj.herald');
    else if (chan >= 0) obj = t('obj.channel', Math.floor(sim.beacons[chan].progress * 100));
    else {
      let litN = 0;
      for (const b of sim.beacons) if (b.lit) litN++;
      obj = t('obj.light', litN, BEACON_COUNT);
    }
    if (sim.cfg.endless) obj = `∞ ${t('hud.loop', sim.stats.loops + 1)}  ·  ${obj}`;
    this.set('obj', obj, (el, v) => (el.textContent = String(v)));
    // boss bar (final boss, or the herald while it lives)
    let bossE = sim.boss;
    if (!bossE) for (const g of sim.bigs) if (g.alive && g.kind === 'herald') bossE = g;
    this.set('bossOn', bossE ? bossE.kind : '', (_, v) => {
      this.h.boss.classList.toggle('hidden', v === '');
      if (v) this.h.bossname.textContent = t('boss.' + v);
    });
    if (bossE) this.set('bossw', Math.round((bossE.hp / bossE.maxHp) * 500), (_, v) => (this.h.bossfill.style.width = Number(v) / 5 + '%'));
    // counters
    if (this.set('kills', sim.stats.kills, (el, v) => (el.textContent = fmtNum(Number(v))))) {
      /* no bump: too frequent */
    }
    const cind = sim.cinderTotal();
    if (this.set('cinders', cind, (el, v) => (el.textContent = fmtNum(Number(v))))) {
      const w = this.h.cindersWrap;
      w.classList.remove('bump');
      void w.offsetWidth;
      w.classList.add('bump');
    }
    const combo = sim.combo;
    this.set('comboOn', combo >= 15 ? 1 : 0, (_, v) => this.h.combo.classList.toggle('on', v === 1));
    if (combo >= 15) this.set('combon', combo, (el, v) => (el.textContent = '×' + v));
    // first-run tips
    if (!this.save.tutorial) {
      this.tipT += dt;
      const stage = this.tipT < 1 ? 0 : this.tipT < 9 ? 1 : this.tipT < 11 ? 0 : this.tipT < 20 ? 2 : this.tipT < 22 ? 0 : this.tipT < 31 ? 3 : this.tipT < 33 ? 0 : this.tipT < 42 ? 4 : 5;
      if (stage !== this.tipStage) {
        this.tipStage = stage;
        const dev = this.host.input.device;
        const key = stage === 1 ? (dev === 'touch' ? 'tip.move.touch' : dev === 'gamepad' ? 'tip.move.pad' : 'tip.move') : stage === 2 ? 'tip.xp' : stage === 3 ? 'tip.beacon' : stage === 4 ? (dev === 'touch' ? 'tip.skill.touch' : dev === 'gamepad' ? 'tip.skill.pad' : 'tip.skill') : '';
        const kk = this.save.settings.keys, pp = this.save.settings.pad;
        const pad = dev === 'gamepad';
        if (key) this.h.tip.textContent = stage === 4 ? t(key, pad ? padLabel(pp.skill) : keyLabel(kk.skill)) : t(key, this.moveKeys(), pad ? padLabel(pp.dash) : keyLabel(kk.dash));
        this.h.tip.classList.toggle('on', key !== '');
        if (stage === 5) {
          this.save.tutorial = true;
          this.host.save.save();
        }
      }
    }
    // touch stick
    const stick = this.host.input.stick;
    this.set('stickOn', stick.active ? 1 : 0, (_, v) => this.h.stick.classList.toggle('on', v === 1));
    if (stick.active) {
      this.h.stick.style.left = stick.ox + 'px';
      this.h.stick.style.top = stick.oy + 'px';
      const dx = stick.x - stick.ox, dy = stick.y - stick.oy;
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, 62 / d);
      this.h.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    }
    // fps
    if (this.save.settings.showFps) {
      this.fpsAcc += fps;
      this.fpsN++;
      if (this.fpsN >= 20) {
        this.h.fps.textContent = `${Math.round(this.fpsAcc / this.fpsN)} fps · ${sim.enemies.length}`;
        this.fpsAcc = 0;
        this.fpsN = 0;
      }
    }
    this.set('fpsOn', this.save.settings.showFps ? 1 : 0, (_, v) => this.h.fps.classList.toggle('hidden', v !== 1));
    // minimap at 8 Hz
    this.miniT -= dt;
    if (this.miniT <= 0) {
      this.miniT = 0.125;
      this.drawMini(sim);
    }
  }

  private drawMini(sim: Sim) {
    const c = this.mini;
    const S = 190, R = S / 2;
    const k = (R - 6) / (sim.world.playRadius + 8);
    c.clearRect(0, 0, S, S);
    c.save();
    c.translate(R, R);
    // island
    c.beginPath();
    c.arc(0, 0, (sim.world.playRadius + 6) * k, 0, Math.PI * 2);
    c.fillStyle = 'rgba(60, 96, 104, 0.5)';
    c.fill();
    c.strokeStyle = 'rgba(160, 220, 230, 0.35)';
    c.lineWidth = 1.5;
    c.stroke();
    // paths
    c.strokeStyle = 'rgba(210, 190, 150, 0.28)';
    c.lineWidth = 2;
    c.beginPath();
    for (const s of sim.world.paths) {
      c.moveTo(s.ax * k, s.az * k);
      c.lineTo(s.bx * k, s.bz * k);
    }
    c.stroke();
    // lit beacon havens
    for (const b of sim.beacons) {
      if (!b.lit) continue;
      c.beginPath();
      c.arc(b.x * k, b.z * k, 11 * k + 4, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255, 170, 70, 0.22)';
      c.fill();
    }
    // enemies as a faint heat haze (sampled)
    c.fillStyle = 'rgba(255, 80, 120, 0.55)';
    const step = Math.max(1, Math.floor(sim.enemies.length / 120));
    for (let i = 0; i < sim.enemies.length; i += step) {
      const e = sim.enemies[i];
      c.fillRect(e.x * k - 1, e.z * k - 1, 2, 2);
    }
    // the merchant: a gold coin with a dark ring
    const mc = sim.merchant;
    if (mc && !mc.visited) {
      c.fillStyle = '#ffd24a';
      c.beginPath();
      c.arc(mc.x * k, mc.z * k, 4.5, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.6)';
      c.lineWidth = 1.5;
      c.stroke();
    }
    // unused shrines: small violet diamonds
    c.fillStyle = '#c6a2ff';
    for (const s of sim.shrines) {
      if (s.used) continue;
      c.beginPath();
      c.moveTo(s.x * k, s.z * k - 4);
      c.lineTo(s.x * k + 3.5, s.z * k);
      c.lineTo(s.x * k, s.z * k + 4);
      c.lineTo(s.x * k - 3.5, s.z * k);
      c.fill();
    }
    for (const kx of sim.pickups) {
      if (kx.kind !== 'chest') continue;
      c.fillStyle = '#ffd24a';
      c.fillRect(kx.x * k - 2.5, kx.z * k - 2.5, 5, 5);
    }
    // hearth
    c.fillStyle = '#ffcf9a';
    c.beginPath();
    c.arc(0, 0, 2.5, 0, Math.PI * 2);
    c.fill();
    // beacons
    for (const b of sim.beacons) {
      c.beginPath();
      c.arc(b.x * k, b.z * k, b.lit ? 4.5 : 4, 0, Math.PI * 2);
      c.fillStyle = b.lit ? '#ffb347' : b.progress > 0 ? '#ffe2a8' : '#7fd4ff';
      c.fill();
      if (!b.lit) {
        c.strokeStyle = 'rgba(8,10,24,0.9)';
        c.lineWidth = 1.5;
        c.stroke();
      }
    }
    for (const g of sim.bigs) {
      if (!g.alive) continue;
      c.fillStyle = g.kind === 'eclipse' ? '#ff5a3c' : '#b86bff';
      c.beginPath();
      c.arc(g.x * k, g.z * k, g.kind === 'eclipse' ? 6 : 4.5, 0, Math.PI * 2);
      c.fill();
    }
    // player
    const p = sim.player;
    c.translate(p.x * k, p.z * k);
    c.rotate(p.aim);
    c.fillStyle = '#ffffff';
    c.strokeStyle = 'rgba(8,10,24,0.9)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(7, 0);
    c.lineTo(-4.5, -4.5);
    c.lineTo(-2, 0);
    c.lineTo(-4.5, 4.5);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }

  // ================================================================== modals
  private choiceCard(c: Choice, i: number, sim: Sim): string {
    let color = '#7fd4ff', ic = 'star', name = '', lv = '', ds = '', tag = '', cls = '', evo = '';
    switch (c.type) {
      case 'weapon':
        color = hex(WEAPONS[c.id].color);
        ic = c.id;
        name = t('w.' + c.id);
        lv = c.isNew ? '' : `Lv ${c.level - 1} → ${c.level}`;
        ds = weaponLevelText(c.id, c.level);
        tag = c.isNew ? `<span class="tag new">${t('common.new')}</span>` : `<span class="tag">${t('tag.weapon')}</span>`;
        if (c.level <= MAX_WEAPON_LEVEL) evo = `<div class="evo">${icon('up', 12)}${t('p.' + WEAPONS[c.id].evo)}${sim.passiveLevel(WEAPONS[c.id].evo) > 0 ? ' ✓' : ''}</div>`;
        if (c.isNew) cls = 'sheen';
        // owning the partner weapon: point out the synergy this weapon belongs to
        for (const sid of SYNERGY_IDS) {
          const sd = SYNERGIES[sid];
          const other = sd.a === c.id ? sd.b : sd.b === c.id ? sd.a : null;
          if (other && sim.weapon(other) && !sim.synergies.has(sid)) evo += `<div class="evo syn" style="color:${hex(sd.color)}">${icon(other, 12)}${t('syn.hint', t('syn.' + sid), SYNERGY_LEVEL)}</div>`;
        }
        // this pick finishes an evolution recipe: say so
        if (c.level === MAX_WEAPON_LEVEL && sim.passiveLevel(WEAPONS[c.id].evo) > 0) {
          cls = 'ready';
          evo = `<div class="evo ready">${icon('star', 12)}${t('levelup.ready')}</div>`;
        }
        break;
      case 'evolve':
        color = '#ffd24a';
        ic = c.id;
        name = t(`w.${c.id}.e`);
        lv = `${t('w.' + c.id)} → ★`;
        ds = t(`w.${c.id}.ed`);
        tag = `<span class="tag" style="color:var(--gold)">${t('tag.evo')}</span>`;
        cls = 'evolve';
        break;
      case 'passive': {
        color = hex(PASSIVES[c.id].color);
        ic = c.id;
        name = t('p.' + c.id);
        lv = c.isNew ? '' : `Lv ${c.level - 1} → ${c.level}`;
        ds = passiveText(c.id, c.level);
        tag = c.isNew ? `<span class="tag new">${t('common.new')}</span>` : `<span class="tag">${t('tag.passive')}</span>`;
        const partner = WEAPON_IDS.filter((w) => WEAPONS[w].evo === c.id && sim.weapon(w));
        if (partner.length) evo = `<div class="evo">${icon('up', 12)}${partner.map((w) => t(`w.${w}.e`)).join(', ')}</div>`;
        if (c.isNew) cls = 'sheen';
        if (c.isNew && partner.some((w) => sim.weapon(w)!.level === MAX_WEAPON_LEVEL)) {
          cls = 'ready';
          evo = `<div class="evo ready">${icon('star', 12)}${t('levelup.ready')}</div>`;
        }
        break;
      }
      case 'relic':
        color = hex(RELIC_COLORS[c.id]);
        ic = c.id;
        name = t('r.' + c.id);
        ds = t(`r.${c.id}.d`);
        tag = `<span class="tag">${t('tag.relic')}</span>`;
        cls = 'sheen relic';
        break;
      case 'heal':
        color = '#7dff9b'; ic = 'heart'; name = t('choice.heal'); ds = t('choice.heal.d'); tag = `<span class="tag">${t('tag.bonus')}</span>`;
        break;
      case 'cinder':
        color = '#ffb347'; ic = 'cinder'; name = t('choice.cinder'); ds = t('choice.cinder.d'); tag = `<span class="tag">${t('tag.bonus')}</span>`;
        break;
      case 'buy': {
        const look: Record<string, [string, string]> = { salve: ['heart', '#7dff9b'], whetstone: ['sword', '#ffb070'], curio: ['star', '#ffd24a'], map: ['reroll', '#7fd4ff'], tonic: ['vigor', '#ff8aa0'] };
        color = look[c.id][1]; ic = look[c.id][0]; name = t('ware.' + c.id); ds = t(`ware.${c.id}.d`);
        tag = `<span class="tag" style="color:var(--amber-hot)">${icon('cinder', 11)} ${c.cost}</span>`;
        cls = sim.stats.cinders >= c.cost ? 'sheen' : 'poor';
        break;
      }
      case 'awaken':
        color = hex(SKILLS[sim.skill].color); ic = c.id === 'potency' ? 'might' : c.id === 'swiftness' ? 'rite' : 'reach'; name = t('aw.' + c.id); ds = t(`aw.${c.id}.d`); tag = `<span class="tag">${t('setup.skill')}</span>`; cls = 'sheen';
        break;
      case 'boon':
        color = BOON_LOOK[c.id][1]; ic = BOON_LOOK[c.id][0]; name = t('boon.' + c.id); ds = t(`boon.${c.id}.d`); tag = `<span class="tag">${t('tag.shrine')}</span>`; cls = 'sheen';
        break;
    }
    return `<button class="card f ${cls}" style="--c:${color}" data-act="choose" data-arg="${i}"><span class="key">${i + 1}</span>${tag}
      <span class="pic">${icon(ic, 40)}</span><span class="nm">${name}</span>${lv ? `<span class="lv">${lv}</span>` : ''}<span class="ds">${ds}</span>${evo}</button>`;
  }

  showPending(sim: Sim) {
    const pend = sim.pending[0];
    if (!pend) return;
    this.purse = sim.stats.cinders;
    this.pendingRef = pend;
    this.banishMode = false;
    const p = sim.player;
    if (pend.type === 'chest') {
      const items = pend.choices.map((c, i) => {
        let color = '#ffd24a', ic = 'star', name = '', ds = '';
        if (c.type === 'weapon') { color = hex(WEAPONS[c.id].color); ic = c.id; name = `${t('w.' + c.id)}  Lv ${sim.weapon(c.id)?.level ?? c.level}`; ds = weaponLevelText(c.id, c.level); }
        else if (c.type === 'evolve') { ic = c.id; name = `★ ${t(`w.${c.id}.e`)}`; ds = t(`w.${c.id}.ed`); }
        else if (c.type === 'passive') { color = hex(PASSIVES[c.id].color); ic = c.id; name = `${t('p.' + c.id)}  Lv ${c.level}`; ds = passiveText(c.id, c.level); }
        else if (c.type === 'heal') { color = '#7dff9b'; ic = 'heart'; name = t('choice.heal'); ds = t('choice.heal.d'); }
        return `<div class="item" style="--c:${color};animation-delay:${0.5 + i * 0.22}s"><span class="slot" style="--c:${color}">${icon(ic, 22)}</span><div><div class="nm">${name}</div><div class="ds">${ds}</div></div></div>`;
      }).join('');
      this.setModal('pending', `<div class="chest-wrap"><div class="m-title gold">${t('chest.title')}</div><div class="chest-ico">${icon('chest', 110)}</div>
        <div class="loot">${items}<div class="item" style="--c:#ffb347;animation-delay:${0.5 + pend.choices.length * 0.22}s"><span class="slot" style="--c:#ffb347">${icon('cinder', 22)}</span><div><div class="nm">+${pend.cinders} ${t('shop.cinders')}</div></div></div></div>
        <div class="m-actions"><button class="btn primary f" data-act="chest-ok">${t('common.continue')}</button></div></div>`, 'clear');
      return;
    }
    const relic = pend.type === 'relic' || pend.type === 'shrine' || pend.type === 'awaken' || pend.type === 'merchant';
    const shrine = pend.type === 'shrine' || pend.type === 'merchant';
    const merchant = pend.type === 'merchant';
    const awaken = pend.type === 'awaken';
    const cards = pend.choices.map((c, i) => this.choiceCard(c, i, sim)).join('');
    const actions = awaken
      ? ''
      : relic
      ? `<button class="btn ghost small f" data-act="skip">${icon('skip', 14)}${t('levelup.skip')}</button>`
      : `<button class="btn small f" data-act="reroll" ${p.rerolls > 0 ? '' : 'disabled'}>${icon('reroll', 15)}${t('levelup.reroll')} <span class="n">${p.rerolls}</span></button>
         <button class="btn small f" data-act="banish" ${p.banishes > 0 ? '' : 'disabled'}>${icon('banish', 15)}${t('levelup.banish')} <span class="n">${p.banishes}</span></button>
         <button class="btn ghost small f" data-act="skip">${icon('skip', 14)}${t('levelup.skip')}</button>`;
    this.setModal('pending', `
      <div class="m-title ${shrine ? 'shrine' : relic ? 'gold' : 'lv'}">${t(awaken ? 'aw.title' : merchant ? 'merchant.title' : shrine ? 'shrine.title' : relic ? 'relic.title' : 'levelup.title')}</div>
      <div class="m-sub">${awaken ? t('aw.sub', t('sk.' + sim.skill)) : merchant ? t('merchant.sub', fmtNum(sim.stats.cinders)) : t(shrine ? 'shrine.sub' : relic ? 'relic.sub' : 'levelup.sub')}</div>
      <div class="choices">${cards}</div>
      <div class="m-actions">${actions}</div>`, 'clear');
  }

  private buildHtml(sim: Sim): string {
    const p = sim.player;
    const rows: string[] = [];
    if (sim.pacts.size) {
      rows.push(`<h4>${t('setup.pacts')}</h4>`);
      for (const id of sim.pacts) rows.push(`<div class="row"><span class="slot" style="--c:${hex(PACTS[id].color)}">${icon('oathbrand', 18)}</span><div style="min-width:0"><div class="nm">${t('pact.' + id)}</div><div class="ds">${t(`pact.${id}.d`)}</div></div></div>`);
    }
    if (sim.synergies.size) {
      rows.push(`<h4>${t('syn.title')}</h4>`);
      for (const id of sim.synergies) rows.push(`<div class="row"><span class="slot" style="--c:${hex(SYNERGIES[id].color)}">${icon(SYNERGIES[id].a, 14)}${icon(SYNERGIES[id].b, 14)}</span><div style="min-width:0"><div class="nm">${t('syn.' + id)}</div><div class="ds">${t(`syn.${id}.d`)}</div></div></div>`);
    }
    const sk = SKILLS[sim.skill];
    rows.push(`<h4>${t('setup.skill')}</h4>`);
    rows.push(`<div class="row"><span class="slot" style="--c:${hex(sk.color)}">${icon(sk.id, 22)}</span><div style="min-width:0"><div class="nm">${t('sk.' + sk.id)} · ${t('sk.cd', Math.round(sim.skillCooldown() * 10) / 10)}</div><div class="ds">${t(`sk.${sk.id}.d`)}</div></div></div>`);
    rows.push(`<h4>${t('tag.weapon')}</h4>`);
    for (const w of p.weapons) {
      const evo = w.level >= EVOLVED_LEVEL;
      rows.push(`<div class="row"><span class="slot ${evo ? 'evo' : ''}" style="--c:${hex(WEAPONS[w.id].color)}">${icon(w.id, 22)}<b>${evo ? '★' : w.level}</b></span><div style="min-width:0"><div class="nm">${weaponName(w.id, w.level)}</div><div class="ds">${evo ? t(`w.${w.id}.ed`) : evoHint(w.id)}</div></div></div>`);
    }
    rows.push(`<h4>${t('tag.passive')}</h4>`);
    if (p.passives.length === 0) rows.push(`<div class="row"><div class="ds">${t('pause.none')}</div></div>`);
    for (const w of p.passives) rows.push(`<div class="row"><span class="slot" style="--c:${hex(PASSIVES[w.id].color)}">${icon(w.id, 22)}<b>${w.level}</b></span><div style="min-width:0"><div class="nm">${t('p.' + w.id)}</div><div class="ds">${passiveText(w.id, w.level)}</div></div></div>`);
    if (p.relics.length) {
      rows.push(`<h4>${t('pause.relics')}</h4>`);
      for (const r of p.relics) rows.push(`<div class="row"><span class="slot relic" style="--c:${hex(RELIC_COLORS[r])}">${icon(r, 22)}</span><div style="min-width:0"><div class="nm">${t('r.' + r)}</div><div class="ds">${t(`r.${r}.d`)}</div></div></div>`);
    }
    return rows.join('');
  }

  showPause(sim: Sim) {
    this.setModal('pause', `
      <div class="panel pause-panel">
        <h2>${t('pause.title')}</h2>
        <div class="build scroll">${this.buildHtml(sim)}</div>
        <div class="pause-actions">
          <button class="btn primary f" data-act="resume">${icon('play', 18)}${t('pause.resume')}</button>
          <button class="btn f" data-act="pause-settings">${icon('gear', 18)}${t('menu.settings')}</button>
          <button class="btn f" data-act="restart">${icon('reroll', 18)}${t('pause.restart')}</button>
          <button class="btn ghost danger f" data-act="quit">${t('pause.quit')}</button>
        </div>
      </div>`);
  }

  showResult(sum: RunSummary) {
    this.lastSummary = sum;
    const maxD = Math.max(1, ...sum.weapons.map((w) => w.dealt));
    const bars = sum.weapons.map((w) => `<div class="wbar" style="--c:${hex(WEAPONS[w.id as keyof typeof WEAPONS].color)}"><span class="slot small ${w.level >= EVOLVED_LEVEL ? 'evo' : ''}" style="--c:${hex(WEAPONS[w.id as keyof typeof WEAPONS].color)}">${icon(w.id, 15)}</span><div class="track"><i data-w="${(w.dealt / maxD) * 100}"></i></div><span class="v">${fmtNum(w.dealt)}</span></div>`).join('');
    const unlocks: string[] = [];
    for (const c of sum.unlockedChars) unlocks.push(`<div class="unlock">${icon(c, 22)}<div><small>${t('result.unlock')} · ${t('setup.char')}</small>${t('c.' + c)}</div></div>`);
    for (const b of sum.unlockedBiomes) unlocks.push(`<div class="unlock">${icon(BIOME_ICON[b], 22)}<div><small>${t('result.unlock')} · ${t('setup.stage')}</small>${t('b.' + b)}</div></div>`);
    if (sum.unlockedDiff >= 0) unlocks.push(`<div class="unlock">${icon('crown', 22)}<div><small>${t('result.unlock')} · ${t('setup.diff')}</small>${t('d.' + sum.unlockedDiff)}</div></div>`);
    if (sum.dailyBonus > 0) unlocks.push(`<div class="unlock ach">${icon('star', 22)}<div><small>${t('menu.daily')} · +${sum.dailyBonus}</small>${t('daily.first')}</div></div>`);
    for (const a of sum.achievements) {
      const def = ACHIEVEMENTS.find((x) => x.id === a);
      unlocks.push(`<div class="unlock ach">${icon('trophy', 22)}<div><small>${t('result.ach')} · +${def?.reward ?? 0}</small>${t('a.' + a)}</div></div>`);
    }
    const cell = (v: string, k: string) => `<div class="res-cell"><b>${v}</b><span>${k}</span></div>`;
    this.setModal('result', `
      <div class="panel result">
        <div>${sum.daily ? `<div class="daily-tag">${icon('star', 14)}${t('menu.daily')}</div>` : ''}${sum.endless ? `<div class="daily-tag" style="color:var(--violet)">${icon('reroll', 14)}${t('result.endless')}</div>` : ''}<div class="m-title ${sum.win ? 'gold' : 'red'}">${t(sum.win ? 'result.win' : 'result.lose')}</div><div class="m-sub">${t(sum.win ? 'result.win.sub' : 'result.lose.sub')}${sum.newBest ? ` · <b style="color:var(--gold)">${t('result.best')}</b>` : ''}</div>${sum.win && !sum.endless ? `<div class="epilogue">${t('epi.' + sum.biome)}</div>` : ''}${sum.daily ? '' : `<div class="seed-tag">${t('setup.seed')} ${sum.seed}</div>`}</div>
        <div class="res-grid">${cell(fmtTime(sum.time), t('result.time'))}${cell(String(sum.level), t('result.level'))}${cell(fmtNum(sum.kills), t('result.kills'))}${sum.endless ? cell(String(sum.loops), t('result.loops')) : cell(`${sum.beacons}/${BEACON_COUNT}`, t('result.beacons'))}</div>
        <div class="res-cols scroll">
          <div><div class="group-label">${t('result.weapons')}</div><div class="wbars">${bars}</div>
            <div class="statline" style="margin-top:0.9em"><span class="k">${t('result.dmg')}</span><span class="v">${fmtNum(sum.dmgDealt)}</span><span class="k">${t('result.combo')}</span><span class="v">×${fmtNum(sum.maxCombo)}</span>
              <span class="k">${t('setup.skill')}</span><span class="v">${icon(sum.skill, 15)} ${t('sk.' + sum.skill)}${sum.awakening ? ` · ${t('aw.' + sum.awakening)}` : ''}</span>
              ${sum.synergies.length ? `<span class="k">${t('syn.title')}</span><span class="v">${sum.synergies.map((id) => t('syn.' + id)).join(', ')}</span>` : ''}</div></div>
          <div class="rewards"><div class="reward-big"><span>${t('result.cinders')}</span><b>${icon('cinder', 22)}<span data-count="${sum.cinders + sum.bonus + sum.dailyBonus}">0</span></b></div>${unlocks.join('')}</div>
        </div>
        <div class="pause-actions"><button class="btn primary f" data-act="retry">${icon('reroll', 18)}${t('result.retry')}</button><button class="btn f" data-act="menu">${t('result.menu')}</button></div>
      </div>`, sum.win ? 'clear' : '');
    requestAnimationFrame(() => {
      this.modalEl.querySelectorAll<HTMLElement>('[data-w]').forEach((e) => (e.style.width = e.dataset.w + '%'));
    });
    const cnt = this.modalEl.querySelector<HTMLElement>('[data-count]');
    if (cnt) {
      const target = Number(cnt.dataset.count);
      const t0 = performance.now();
      const tick = () => {
        if (!cnt.isConnected) return;
        const k = Math.min(1, (performance.now() - t0) / 1400);
        cnt.textContent = fmtNum(target * (1 - Math.pow(1 - k, 3)));
        if (k < 1) requestAnimationFrame(tick);
      };
      tick();
    }
  }

  get language() {
    return getLang();
  }
}
