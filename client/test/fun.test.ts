import { expect, test } from 'vitest';
import { FUN_KEYS, funOn, setFun, usableKind } from '../src/fun.js';

test('the fun is off by default: its props do nothing and its keys are taken (M6 A11)', () => {
  expect(funOn()).toBe(false);
  expect(usableKind('cabinet')).toBe(false);
  expect(usableKind('gong')).toBe(false);
  // Looking after the agents, and the dog, are never fun-only.
  for (const k of ['desk', 'elevator', 'issues', 'services', 'dog']) expect(usableKind(k)).toBe(true);
  for (const k of ['KeyT', 'Digit3', 'KeyF']) expect(FUN_KEYS.has(k)).toBe(true);
  for (const k of ['KeyN', 'KeyE', 'KeyM', 'KeyV', 'KeyG']) expect(FUN_KEYS.has(k)).toBe(false);
  setFun(true);
  expect(usableKind('cabinet')).toBe(true);
  setFun(false);
});
