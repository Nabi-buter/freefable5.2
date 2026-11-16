/** Unified keyboard / mouse / gamepad / touch input. */

/** true when the device's main pointer is a finger (phones, tablets) */
export function isTouchPrimary(): boolean {
  try {
    if (window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches) return true;
    return navigator.maxTouchPoints > 0 && !window.matchMedia('(any-pointer: fine)').matches;
  } catch {
    return false;
  }
}

export type Device = 'kbm' | 'gamepad' | 'touch';

export interface StickView {
  active: boolean;
  ox: number;
  oy: number;
  x: number;
  y: number;
}

export class Input {
  /** movement vector, screen space (x right, y down), length <= 1 */
  moveX = 0;
  moveY = 0;
  /** pointer position in css px (mouse aim) */
  pointerX = 0;
  pointerY = 0;
  /** right-stick aim direction in screen space, or 0,0 when idle */
  stickAimX = 0;
  stickAimY = 0;
  device: Device = 'kbm';
  /** virtual stick state for the touch HUD */
  stick: StickView = { active: false, ox: 0, oy: 0, x: 0, y: 0 };
  private keys = new Set<string>();
  private dashQ = false;
  private pauseQ = false;
  private confirmQ = false;
  private navQ = 0;
  private numQ = 0;
  private keyQ: string[] = [];
  private backQ = false;
  private padPrev: boolean[] = [];
  private padNavT = 0;
  private stickId = -1;
  private el: HTMLElement;
  /** set false while menus are open so game keys do not leak */
  onDevice: ((d: Device) => void) | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    if (isTouchPrimary()) this.device = 'touch';
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.pauseQ = true;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.keys.clear();
        this.pauseQ = true;
      }
    });
    window.addEventListener('mousemove', (e) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 1) this.setDevice('kbm');
    });
    window.addEventListener('mousedown', (e) => {
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      if (e.button === 2) this.dashQ = true;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('touchstart', (e) => this.onTouch(e), { passive: false });
    el.addEventListener('touchmove', (e) => this.onTouch(e), { passive: false });
    el.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
    el.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });
  }

  private setDevice(d: Device) {
    if (d !== this.device) {
      this.device = d;
      this.onDevice?.(d);
    }
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const c = e.code;
    if (down) {
      if (!this.keys.has(c)) {
        if (c === 'Space' || c === 'ShiftLeft' || c === 'ShiftRight') this.dashQ = true;
        if (c === 'Escape' || c === 'KeyP') this.pauseQ = true;
        if (c === 'Escape' || c === 'Backspace') this.backQ = true;
        if (c === 'Enter' || c === 'Space') this.confirmQ = true;
        if (c === 'ArrowLeft' || c === 'KeyA' || c === 'ArrowUp' || c === 'KeyW') this.navQ = -1;
        if (c === 'ArrowRight' || c === 'KeyD' || c === 'ArrowDown' || c === 'KeyS') this.navQ = 1;
        if (this.keyQ.length < 8) this.keyQ.push(c);
        if (c.startsWith('Digit')) this.numQ = Number(c.slice(5));
      }
      this.keys.add(c);
      this.setDevice('kbm');
      if (c === 'Space' || c.startsWith('Arrow') || c === 'Tab') e.preventDefault();
    } else this.keys.delete(c);
  }

  private onTouch(e: TouchEvent) {
    this.setDevice('touch');
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (this.stickId === -1 && e.type === 'touchstart' && t.clientX < window.innerWidth * 0.55) {
        this.stickId = t.identifier;
        this.stick.active = true;
        this.stick.ox = t.clientX;
        this.stick.oy = t.clientY;
        this.stick.x = t.clientX;
        this.stick.y = t.clientY;
      } else if (t.identifier === this.stickId) {
        this.stick.x = t.clientX;
        this.stick.y = t.clientY;
        // let the stick base follow the thumb when it is dragged far
        const dx = this.stick.x - this.stick.ox, dy = this.stick.y - this.stick.oy;
        const d = Math.hypot(dx, dy);
        const R = 62;
        if (d > R) {
          this.stick.ox += (dx / d) * (d - R);
          this.stick.oy += (dy / d) * (d - R);
        }
      }
    }
    if (e.cancelable) e.preventDefault();
  }

  private onTouchEnd(e: TouchEvent) {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === this.stickId) {
        this.stickId = -1;
        this.stick.active = false;
      }
    }
    if (e.cancelable) e.preventDefault();
  }

  /** called by the touch HUD dash button */
  requestDash() {
    this.dashQ = true;
  }
  requestPause() {
    this.pauseQ = true;
  }

  /** read gamepad + compose the movement vector. Call once per frame. */
  poll(dt: number) {
    let mx = 0, my = 0;
    const k = this.keys;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (k.has('KeyW') || k.has('ArrowUp')) my -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) my += 1;
    this.stickAimX = 0;
    this.stickAimY = 0;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const p of pads) if (p && p.connected) {
      pad = p;
      break;
    }
    if (pad) {
      const dz = 0.22;
      const lx = pad.axes[0] ?? 0, ly = pad.axes[1] ?? 0;
      const rx = pad.axes[2] ?? 0, ry = pad.axes[3] ?? 0;
      if (Math.hypot(lx, ly) > dz) {
        mx += lx;
        my += ly;
        this.setDevice('gamepad');
      }
      if (Math.hypot(rx, ry) > 0.35) {
        this.stickAimX = rx;
        this.stickAimY = ry;
        this.setDevice('gamepad');
      }
      const b = (i: number) => !!pad!.buttons[i]?.pressed;
      const edge = (i: number) => b(i) && !this.padPrev[i];
      if (edge(0) || edge(5) || edge(7) || edge(4)) {
        this.dashQ = true;
        this.setDevice('gamepad');
      }
      if (edge(0)) this.confirmQ = true;
      if (edge(9) || edge(8)) {
        this.pauseQ = true;
        this.backQ = true;
      }
      this.padNavT -= dt;
      const navX = (b(15) ? 1 : 0) - (b(14) ? 1 : 0) + (b(13) ? 1 : 0) - (b(12) ? 1 : 0) + (Math.abs(lx) > 0.6 ? Math.sign(lx) : Math.abs(ly) > 0.6 ? Math.sign(ly) : 0);
      if (edge(1)) this.backQ = true;
      if (edge(2)) this.keyQ.push('KeyR');
      if (navX !== 0 && this.padNavT <= 0) {
        this.navQ = Math.sign(navX);
        this.padNavT = 0.22;
      }
      if (navX === 0) this.padNavT = 0;
      for (let i = 0; i < pad.buttons.length; i++) this.padPrev[i] = b(i);
    }
    if (this.stick.active) {
      const R = 62;
      const dx = (this.stick.x - this.stick.ox) / R, dy = (this.stick.y - this.stick.oy) / R;
      const d = Math.hypot(dx, dy);
      if (d > 0.15) {
        mx += dx;
        my += dy;
      }
    }
    const l = Math.hypot(mx, my);
    if (l > 1) {
      mx /= l;
      my /= l;
    }
    this.moveX = mx;
    this.moveY = my;
  }

  takeDash(): boolean {
    const v = this.dashQ;
    this.dashQ = false;
    return v;
  }
  takePause(): boolean {
    const v = this.pauseQ;
    this.pauseQ = false;
    return v;
  }
  takeConfirm(): boolean {
    const v = this.confirmQ;
    this.confirmQ = false;
    return v;
  }
  takeNav(): number {
    const v = this.navQ;
    this.navQ = 0;
    return v;
  }
  takeNumber(): number {
    const v = this.numQ;
    this.numQ = 0;
    return v;
  }
  takeBack(): boolean {
    const v = this.backQ;
    this.backQ = false;
    return v;
  }
  takeKeys(): string[] {
    if (this.keyQ.length === 0) return this.keyQ;
    const k = this.keyQ;
    this.keyQ = [];
    return k;
  }
  clearQueues() {
    this.dashQ = this.pauseQ = this.confirmQ = this.backQ = false;
    this.navQ = 0;
    this.numQ = 0;
    this.keyQ.length = 0;
  }
}
