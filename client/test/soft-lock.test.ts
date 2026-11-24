import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { PlayerInput } from '../src/player/pointer.js';

// Orca's built-in browser grants the pointer lock and takes it back ~7 ms later. The office then
// keeps its own "soft" lock: one click turns mouse-look on without holding a button, Esc turns it off.

class Input extends PlayerInput {}

let win: EventTarget;
let doc: EventTarget & { pointerLockElement: unknown; exitPointerLock(): void };
let now = 0;

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

beforeEach(() => {
  now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  win = new EventTarget();
  doc = Object.assign(new EventTarget(), {
    pointerLockElement: null as unknown,
    exitPointerLock() {
      doc.pointerLockElement = null;
      doc.dispatchEvent(new Event('pointerlockchange'));
    },
  });
  setGlobal('window', win);
  setGlobal('document', doc);
  setGlobal('navigator', { userActivation: { isActive: true } });
});
afterEach(() => vi.restoreAllMocks());

/** A canvas whose lock the browser grants and, with `revokeAfter`, drops that many ms later. */
function canvas(revokeAfter: number | null) {
  const dom = Object.assign(new EventTarget(), {
    style: { cursor: '' },
    requestPointerLock() {
      doc.pointerLockElement = dom;
      doc.dispatchEvent(new Event('pointerlockchange'));
      if (revokeAfter !== null) {
        now += revokeAfter;
        doc.pointerLockElement = null;
        doc.dispatchEvent(new Event('pointerlockchange'));
      }
      return Promise.resolve();
    },
  });
  return dom;
}

function pointer(target: EventTarget, type: string, extra: Record<string, unknown> = {}) {
  const e = new Event(type);
  Object.assign(e, { pointerType: 'mouse', button: 0, clientX: 0, clientY: 0, movementX: 0, movementY: 0, ...extra });
  target.dispatchEvent(e);
}

function key(type: string, k: string) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { key: k, code: k });
  win.dispatchEvent(e);
}

test('a lock the browser takes straight back turns into a soft lock that looks without holding', () => {
  const dom = canvas(7);
  const input = new Input(dom as unknown as HTMLElement);
  pointer(dom, 'pointerdown');
  pointer(win, 'pointerup');
  expect(input.soft).toBe(true);
  expect(input.locked).toBe(true);
  expect(dom.style.cursor).toBe('none');
  const yaw = input.camYaw;
  now += 500;
  pointer(win, 'pointermove', { movementX: 40 });
  expect(input.camYaw).toBeLessThan(yaw);
});

test('Esc lets go of the soft lock and a click takes it again', () => {
  const dom = canvas(7);
  const input = new Input(dom as unknown as HTMLElement);
  pointer(dom, 'pointerdown');
  key('keydown', 'Escape');
  key('keyup', 'Escape');
  expect(input.locked).toBe(false);
  expect(dom.style.cursor).toBe('');
  const yaw = input.camYaw;
  pointer(win, 'pointermove', { movementX: 40 });
  expect(input.camYaw).toBe(yaw);
  pointer(dom, 'pointerdown');
  expect(input.locked).toBe(true);
});

test('a click while soft-locked is a click at the crosshair', () => {
  const dom = canvas(7);
  const input = new Input(dom as unknown as HTMLElement);
  const clicks: unknown[] = [];
  input.onClick = (ndc) => clicks.push(ndc);
  pointer(dom, 'pointerdown');
  pointer(win, 'pointerup');
  expect(clicks).toHaveLength(0);
  pointer(dom, 'pointerdown');
  expect(clicks).toHaveLength(1);
});

test('a lock the browser keeps stays a real lock', () => {
  const dom = canvas(null);
  const input = new Input(dom as unknown as HTMLElement);
  pointer(dom, 'pointerdown');
  expect(input.soft).toBe(false);
  expect(input.locked).toBe(true);
  now += 5000;
  doc.exitPointerLock();
  expect(input.soft).toBe(false);
  expect(input.locked).toBe(false);
});
