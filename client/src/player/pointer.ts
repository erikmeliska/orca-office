import * as THREE from 'three';
import type { ViewMode } from '../state';

// Your hands on the controls: the keys you hold, and the mouse, which looks around. In first person a
// click on the scene captures the mouse (pointer lock); where it won't lock, or in third person, you
// drag to look. Giving the mouse up for a window and taking it straight back when the window closes
// (by its ✕ or Esc) is fragile: see lock, yieldMouse and the Esc listeners.

const LOOK_SPEED = 0.0022; // radians per pixel of mouse movement while the pointer is locked
const DRAG_LOOK_SPEED = 0.005;
/**
 * Taking the mouse back from a click (see lock's `settle`): how long it must rest once it's taken
 * before it looks around, in ms, and how long at most the view is held still for. Just the flick of
 * the hand that clicked: any longer and looking around straight away feels like the mouse is gone.
 */
const SETTLE_REST = 100;
const SETTLE_MAX = 150;
const CENTER = new THREE.Vector2(0, 0);
/**
 * A lock the browser takes back this soon after granting it, with no Esc and the page not letting go,
 * was never really given: Orca's built-in browser grants the pointer lock and drops it ~7 ms later.
 * From then on the office looks around with a soft lock instead (see softLock).
 */
const REVOKED_WITHIN = 80;

/** Where you look and what steers it: the PlayerController is built on this (see index.ts). */
export abstract class PlayerInput {
  /** Heading of the camera. You look along (-sin, -cos) of it on the XZ plane. */
  camYaw = Math.PI * 0.15;
  camPitch = 0.42;
  camDist = 7.5;
  /** First-person look up (+) / down (-). */
  lookPitch = -0.08;
  view: ViewMode = 'first';
  /**
   * A click (not a drag) on the scene, in normalized device coordinates.
   * In first person it is always the crosshair, (0, 0).
   */
  onClick: ((ndc: THREE.Vector2) => void) | null = null;
  protected keys = new Set<string>();
  private drag: { x: number; y: number; moved: number } | null = null;
  /** Set when this browser won't lock the pointer; first person falls back to drag-to-look. */
  private lockFailed = false;
  private lockPending = false;
  private everLocked = false;
  /** Whether a click or key was behind the lock last asked for. Without one, a refusal is just the browser's rule. */
  private lockOnGesture = false;
  /** The page is letting go of the mouse itself, which isn't you pressing Esc or another tab taking it. */
  private letting = false;
  /**
   * Whether the page was the one to let go of the mouse last. Only then does the browser hand it
   * back without a click or key behind the asking, and the Esc that closes a window isn't one.
   */
  private letGo = false;
  /** Asked for while the page was still letting go of it: taken back as soon as it's free. */
  private lockAfter = false;
  /** When Esc last went down and hasn't come up yet (0 once it has). */
  private escDownAt = 0;
  /** Asked for while Esc was down: taken once it comes up (see lock). */
  private lockOnEscUp = false;
  /** The lock asked for is to settle (see lock), and until when (ms) a lock that landed so still is. */
  private settleNext = false;
  private settleUntil = 0;
  /** When the mouse last moved, or a lock that settles landed. */
  private movedAt = 0;
  /** When the browser last granted the lock (ms), to tell a lock it takes straight back (REVOKED_WITHIN). */
  private lockedAt = 0;
  /**
   * The browser won't keep the pointer locked, so the office keeps its own: one click turns looking
   * around with the mouse on, without holding a button (the cursor is hidden but not held), and Esc
   * turns it off. `softHeld` is whether it's on now.
   */
  private softLock = false;
  private softHeld = false;
  enabled = true;
  /** False while the mouse picks something else (an emote on the wheel), so it doesn't turn the camera. */
  mouseLook = true;

  constructor(private dom: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || isTyping(e)) return;
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.escDownAt = 0;
      this.lockOnEscUp = false;
    });
    // Captured, since the window an Esc closes stops it going any further.
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return;
        // A soft lock lets go on Esc the way the browser's does: that Esc goes no further.
        if (this.softHeld) {
          e.stopImmediatePropagation();
          e.preventDefault();
          this.unlock();
          return;
        }
        this.escDownAt = performance.now();
      },
      true,
    );
    window.addEventListener(
      'keyup',
      (e) => {
        if (e.key !== 'Escape') return;
        this.escDownAt = 0;
        const again = this.lockOnEscUp && this.enabled && this.canLock;
        this.lockOnEscUp = false;
        if (!again) return;
        // Taken here, the browser doesn't also treat this Esc as its own shortcut once the page is done
        // with it, which would let go of the mouse just taken.
        e.preventDefault();
        this.lock();
      },
      true,
    );

    dom.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      if (this.view === 'first' && e.pointerType === 'mouse' && !this.lockFailed) {
        if (this.locked) {
          if (e.button === 0) this.onClick?.(CENTER);
          return;
        }
        this.lock();
      }
      // Drag to orbit (third person) or to look around (first person without pointer lock).
      this.drag = { x: e.clientX, y: e.clientY, moved: 0 };
    });
    window.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      // A click that captured the mouse is not also a click on the world.
      if (!d || d.moved > 5 || !this.enabled || this.locked || this.lockPending || e.target !== dom) return;
      if (this.view === 'first') this.onClick?.(CENTER);
      else {
        const r = dom.getBoundingClientRect();
        this.onClick?.(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
      }
    });
    window.addEventListener('pointermove', (e) => {
      const now = performance.now();
      const rested = now - this.movedAt;
      this.movedAt = now;
      if (!this.mouseLook) return;
      if (this.locked) {
        // Held for a moment under a window (see yieldMouse), the mouse doesn't turn your head.
        if (!this.enabled) return;
        // Taken back from a click, the hand that clicked may be moving on still: that isn't looking around.
        if (this.settleUntil) {
          if (rested < SETTLE_REST && now < this.settleUntil) return;
          this.settleUntil = 0;
        }
        // Some platforms report a bogus huge jump right after locking.
        const clamp = (v: number) => THREE.MathUtils.clamp(v, -250, 250);
        this.look(clamp(e.movementX) * LOOK_SPEED, clamp(e.movementY) * LOOK_SPEED);
        return;
      }
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      if (this.view === 'first') this.look(dx * DRAG_LOOK_SPEED, dy * DRAG_LOOK_SPEED);
      else {
        this.camYaw -= dx * 0.006;
        this.camPitch = THREE.MathUtils.clamp(this.camPitch + dy * 0.004, 0.05, 1.3);
      }
    });
    document.addEventListener('pointerlockchange', () => {
      this.lockPending = false;
      if (this.revoked()) {
        // Taken straight back: look around with the office's own lock from now on, starting with this click.
        this.softLock = true;
        this.letting = false;
        this.lockedAt = 0;
        this.lock(this.settleNext);
        return;
      }
      if (!this.locked) {
        this.letGo = this.letting;
        this.letting = false;
        const again = this.lockAfter && this.enabled && this.canLock;
        this.lockAfter = false;
        if (again) this.lock();
        return;
      }
      this.everLocked = true;
      if (!this.softLock && document.pointerLockElement === this.dom) this.lockedAt = performance.now();
      this.drag = null;
      // The pause to click doesn't count as the hand coming to rest: only once it's taken.
      if (this.settleNext) this.movedAt = performance.now();
      this.settleUntil = this.settleNext ? this.movedAt + SETTLE_MAX : 0;
      this.settleNext = false;
      // A lock that lands with a window open (the one yieldMouse takes, or a relock racing the next window) is let go.
      if (!this.enabled) this.unlock();
    });
    document.addEventListener('pointerlockerror', () => this.refused());
    dom.addEventListener(
      'wheel',
      (e) => {
        if (this.view === 'third') this.camDist = THREE.MathUtils.clamp(this.camDist + e.deltaY * 0.01, 2.5, 16);
        e.preventDefault();
      },
      { passive: false },
    );
  }

  get locked(): boolean {
    return this.softLock ? this.softHeld : document.pointerLockElement === this.dom;
  }

  /** Whether the office looks around with its own lock, because the browser won't keep one (see softLock). */
  get soft(): boolean {
    return this.softLock;
  }

  /** The browser just took back a lock it had granted a moment ago, not for Esc or the page letting go. */
  private revoked(): boolean {
    if (this.softLock || !this.lockedAt || document.pointerLockElement === this.dom) return false;
    const quick = performance.now() - this.lockedAt < REVOKED_WITHIN;
    this.lockedAt = 0;
    return quick && !this.letting && !this.escDownAt;
  }

  /** Whether the mouse is captured and staying so: not while it's being let go of for a window. */
  get hasMouse(): boolean {
    return this.locked && !this.letting;
  }

  /** Whether clicking the scene will capture the mouse for looking around. */
  get canLock(): boolean {
    return this.view === 'first' && (this.softLock || (!this.lockFailed && typeof this.dom.requestPointerLock === 'function'));
  }

  unlock() {
    this.lockAfter = false;
    this.lockOnEscUp = false;
    if (this.softLock) return this.setSoft(false);
    if (!this.locked) return;
    this.letting = true;
    document.exitPointerLock();
  }

  /**
   * Frees the mouse for a window over the game, so that `lock` gets it back when the window closes.
   * The browser only hands the mouse back without a click or key to a page that let go of it itself.
   * So when the mouse is free already (you pressed Esc to click something on screen), the click or
   * key that opens the window takes it for a moment, and it's let go as soon as it lands.
   */
  yieldMouse() {
    if (this.locked) return this.unlock();
    // The office's own lock needs no leave from the browser to be taken back.
    if (this.softLock) return;
    if (this.letGo || !this.canLock || !navigator.userActivation?.isActive) return;
    this.lock();
  }

  clearKeys() {
    this.keys.clear();
  }

  /** Whether any of these keys is held down (and you have the controls). */
  holding(...codes: string[]): boolean {
    return this.enabled && codes.some((c) => this.keys.has(c));
  }

  /**
   * Captures the mouse for looking around, as the first click on the scene does. With `settle` (a
   * click just closed a window), the view holds still until the mouse comes to rest, so the rest of
   * the hand's move doesn't swing it somewhere else.
   */
  lock(settle = false) {
    this.settleNext = settle;
    if (this.softLock) {
      if (!this.softHeld) this.setSoft(true);
      return;
    }
    // Still being let go of, for a window that closed again at once: taken back once it's free.
    if (this.locked && this.letting) this.lockAfter = true;
    if (this.locked || this.lockPending) return;
    // The browser lets go of the mouse on Esc coming up as well as going down, so a lock taken
    // between the two (the Esc that closed a window) is gone again at once, and with it the leave
    // to take it back without a click. Asked for once Esc is up instead, from its keyup (see there).
    // A second on, Esc being held would have repeated, so its keyup went missing.
    if (this.escDownAt && performance.now() - this.escDownAt < 1000) {
      this.lockOnEscUp = true;
      return;
    }
    this.lockOnEscUp = false;
    if (typeof this.dom.requestPointerLock !== 'function') {
      this.lockFailed = true;
      return;
    }
    this.lockPending = true;
    this.lockOnGesture = navigator.userActivation?.isActive ?? true;
    // Asking uses up the browser's leave to hand the mouse back, whatever it answers.
    this.letGo = false;
    try {
      // Newer browsers return a promise; older ones report through pointerlockerror.
      const p = this.dom.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => this.refused());
    } catch {
      this.lockPending = false;
      this.lockFailed = true;
    }
  }

  /**
   * Turns the soft lock on or off and tells everyone listening for the browser's lock (the same
   * pointerlockchange), so the hint bar, windows and games treat it as one.
   */
  private setSoft(on: boolean) {
    if (this.softHeld === on) return;
    this.softHeld = on;
    // Let go of by the page, so taking it back needs no click (see yieldMouse), as with the real lock.
    if (!on) this.letting = true;
    if (this.dom.style) this.dom.style.cursor = on ? 'none' : '';
    document.dispatchEvent(new Event('pointerlockchange'));
  }

  private refused() {
    this.lockPending = false;
    // Locking right after Esc is refused for a moment, and so is asking with no click or key behind
    // it; only give up if it never worked when a click or key asked.
    if (!this.everLocked && this.lockOnGesture) this.lockFailed = true;
  }

  private look(dx: number, dy: number) {
    this.camYaw -= dx;
    this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - dy, -1.45, 1.45);
  }
}

export function isTyping(e?: Event): boolean {
  const el = (e?.target as HTMLElement | null) ?? (document.activeElement as HTMLElement | null);
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable || !!el.closest?.('.xterm');
}
