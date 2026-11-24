import { test } from 'vitest';
import assert from 'node:assert/strict';
import { FLOORS, StubSession } from '../../bridge/src/stub.js';

// The bridge's stub data (bridge/src/stub.ts), taken in by the page's own store: what the 3D office
// boots on in `npm run dev`.
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, String(v)), removeItem: (k: string) => void storage.delete(k) },
});
const { store } = await import('../src/state/index.js');

test("the store takes in the stub's welcome and floor.enter", () => {
  const s = new StubSession('me', new URLSearchParams());
  store.apply(s.welcome());
  assert.equal(store.floor, FLOORS[0]!.info.id);
  assert.equal(store.floors.length, FLOORS.length);
  assert.deepEqual([...store.workers.values()].map((w) => w.status).sort(), FLOORS[0]!.workers.map((w) => w.status).sort());
  assert.equal(store.dog?.name, 'Rex');
  for (const m of s.handle({ t: 'floor.go', floor: FLOORS[1]!.info.id })) store.apply(m);
  assert.equal(store.floor, FLOORS[1]!.info.id);
  assert.equal(store.workers.size, FLOORS[1]!.workers.length);
});
