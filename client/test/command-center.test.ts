import { expect, test } from 'vitest';
import type { OrcaRosterFloor, OrcaWaiting } from '@orca-office/shared/office/protocol/orca';
import { STUCK_DEFAULTS } from '@orca-office/shared/office/stuck';
import { commandCards, kanbanStatuses } from '../src/command-center.js';

// Made up: floors, worktrees and bubbles.
const MIN = 60_000;
const now = 1000 * MIN;
const roster: OrcaRosterFloor[] = [
  {
    floor: 'f-web',
    name: 'demo-web',
    workers: [
      { id: 'a', name: 'fix-login', status: 'working', deskId: 'd1', quietSince: now - MIN, workingSince: now - 10 * MIN, since: now - 10 * MIN, kanban: 'in-progress', terminal: true },
      { id: 'b', name: 'migrate', status: 'needs_input', deskId: 'd2', since: now - 5 * MIN, asks: 'permission', terminal: true, kanban: 'in-progress' },
      { id: 'c', name: 'readme', status: 'done', deskId: 'd3', unread: true, since: now - 2 * MIN, kanban: 'in-review', chat: true },
    ],
  },
  {
    floor: 'f-api',
    name: 'demo-api',
    workers: [
      { id: 'd', name: 'import', status: 'working', deskId: 'd1', quietSince: now - 180 * MIN, workingSince: now - 180 * MIN },
      { id: 'e', name: 'old', status: 'done', deskId: 'd2', since: now - 60 * MIN },
    ],
  },
];
const waiting: OrcaWaiting[] = [
  { key: 'b', kind: 'agent', floor: 'f-web', floorName: 'demo-web', workerId: 'b', deskId: 'd2', name: 'migrate', ask: 'May I?', since: now - 5 * MIN, asks: 'permission', terminal: true },
  { key: 'gate:g', kind: 'gate', floor: 'p-run', floorName: 'Ship it', workerId: null, deskId: 'desk-1', name: 'Decision', ask: 'Charts too?', since: now - 9 * MIN },
];

test('the whole building in columns (M7 B3)', () => {
  const c = commandCards(roster, waiting, STUCK_DEFAULTS, now);
  expect(c.needs.map((x) => x.key)).toEqual(['gate:g', 'b']);
  expect(c.needs[1]).toMatchObject({ asks: 'permission', terminal: true, since: now - 5 * MIN, floorName: 'demo-web' });
  expect(c.working.map((x) => x.key)).toEqual(['a']);
  expect(c.stuck.map((x) => [x.key, x.stuckWhy])).toEqual([['d', 'quiet for 3 h 00 min']]);
  expect(c.done.map((x) => x.key)).toEqual(['c']);
  expect(c.ended.map((x) => x.key)).toEqual(['e']);
});

test('filtered by Orca’s Kanban status (M7 B10)', () => {
  expect(kanbanStatuses(roster)).toEqual(['in-progress', 'in-review']);
  const c = commandCards(roster, waiting, STUCK_DEFAULTS, now, 'in-review');
  expect([...c.needs, ...c.working, ...c.stuck, ...c.done, ...c.ended].map((x) => x.key)).toEqual(['c']);
});
