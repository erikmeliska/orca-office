import { expect, test } from 'vitest';
import type { WorkerInfo, WorkerStatus } from '@orca-office/shared/office/protocol';
import type { OrcaWaiting } from '@orca-office/shared/office/protocol/orca';
import { bannerText, FreshStops, NextStop, pillLabel, stopsInOrder } from '../src/waiting-all.js';

// Made up: floors, worktrees and questions.

const worker = (id: string, status: WorkerStatus, more: Partial<WorkerInfo> = {}): WorkerInfo => ({ id, kind: 'agent', deskId: `desk-${id}`, name: id, color: '#fff', status, acked: false, createdBy: 'test', createdAt: 0, cols: 80, rows: 24, viewers: [], ...more });
const item = (key: string, floor: string, since: number, more: Partial<OrcaWaiting> = {}): OrcaWaiting => ({ key, kind: 'agent', floor, floorName: floor, workerId: key, deskId: `desk-${key}`, name: key, ask: `${key} asks`, since, ...more });

test('the whole building in N order: everyone stopped on you longest first, then this floor’s done ones', () => {
  const all = [item('web', 'f-web', 300), item('gate:g1', 'p-run', 100, { kind: 'gate', workerId: null, name: 'Decision' }), item('api', 'f-api', 200)];
  const here = [worker('web', 'needs_input', { activity: 'Allow npm test?', waitingSince: 300 }), worker('done1', 'done', { waitingSince: 50 }), worker('busy', 'working')];
  const stops = stopsInOrder(all, here, 'f-web');
  expect(stops.map((s) => [s.key, s.needs])).toEqual([
    ['gate:g1', true],
    ['api', true],
    ['web', true],
    ['done1', false],
  ]);
  // This floor's worker says more than the bridge's bubble.
  expect(stops[2]!.ask).toBe('Allow npm test?');
});

test('without the building’s list (the stub), this floor’s workers still count', () => {
  const stops = stopsInOrder([], [worker('a', 'needs_input', { waitingSince: 5 })], 'f', 'demo');
  expect(stops).toMatchObject([{ key: 'a', floor: 'f', floorName: 'demo', needs: true }]);
});

test('the pill says how many and where', () => {
  const s = (key: string, floor: string, floorName = floor) => stopsInOrder([item(key, floor, 1, { floorName })], [], 'here')[0]!;
  expect(pillLabel([s('a', 'here'), s('b', 'f-blog', 'blog-ai')], 'here')).toBe('🙋 2 need you · 1 here, 1 on blog-ai');
  expect(pillLabel([s('a', 'f-blog', 'blog-ai')], 'here')).toBe('🙋 1 needs you · on blog-ai');
  expect(pillLabel([s('a', 'here'), s('b', 'x'), s('c', 'y')], 'here')).toBe('🙋 3 need you · 1 here, 2 on other floors');
  expect(pillLabel([s('a', 'here')], 'here')).toBe('🙋 1 needs you');
  const done = stopsInOrder([], [worker('d', 'done')], 'here');
  expect(pillLabel(done, 'here')).toBe('✅ 1 done');
});

test('the banner says where one on another floor is, and a gate is a decision', () => {
  const now = 10 * 60_000;
  const stops = stopsInOrder([item('api', 'f-api', now - 5 * 60_000, { floorName: 'demo-api' })], [], 'f-web');
  expect(bannerText(stops, 'f-web', now)).toMatchObject({ id: 'api', title: 'api needs you', detail: 'api asks · on demo-api · 5 min' });
  const gate = stopsInOrder([item('gate:g', 'p-run', now, { kind: 'gate', workerId: null, floorName: 'Ship dark mode', ask: 'Charts too?' })], [], 'f-web');
  expect(bannerText(gate, 'f-web', now)).toMatchObject({ title: '⚖️ A decision waits for you', detail: 'Charts too? · on Ship dark mode' });
});

test('N goes round everyone once, then starts over', () => {
  const n = new NextStop();
  const stops = stopsInOrder([item('a', 'f1', 1), item('b', 'f2', 2)], [], 'f1');
  expect([n.next(stops)?.key, n.next(stops)?.key, n.next(stops)?.key]).toEqual(['a', 'b', 'a']);
});

test('fresh: only what started waiting after the first look', () => {
  const f = new FreshStops();
  expect(f.take(stopsInOrder([item('a', 'f', 1)], [], 'f'))).toEqual([]);
  expect(f.take(stopsInOrder([item('a', 'f', 1), item('b', 'g', 2)], [], 'f')).map((s) => s.key)).toEqual(['b']);
  // Asking again (a new wait) is new too.
  expect(f.take(stopsInOrder([item('a', 'f', 9), item('b', 'g', 2)], [], 'f')).map((s) => s.key)).toEqual(['a']);
});
