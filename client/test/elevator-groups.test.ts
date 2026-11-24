import { describe, expect, test } from 'vitest';
import type { FloorInfo } from '@orca-office/shared/office/protocol';
import { elevatorStops, needsYouElsewhere, stopBadges } from '../src/ui/elevator-groups.js';

const floor = (id: string, extra: Partial<FloorInfo> = {}): FloorInfo => ({ id, name: id, dir: '', palette: 0, addedBy: 'orca', addedAt: 0, workers: 0, busy: 0, waiting: 0, people: 0, wing: 0, ...extra });

describe('elevator stops (#31)', () => {
  test('without rooms: the floors top down, numbered from the bottom, no headings', () => {
    const stops = elevatorStops([floor('a'), floor('b'), floor('c')]);
    expect(stops.map((s) => [s.floor.id, s.no, s.heading])).toEqual([
      ['c', 3, undefined],
      ['b', 2, undefined],
      ['a', 1, undefined],
    ]);
  });

  test('project rooms on top (most urgent first), then Staff, then the floors, each group headed', () => {
    const stops = elevatorStops([floor('a'), floor('staff', { room: 'staff' }), floor('p1', { room: 'project', busy: 2 }), floor('b'), floor('p2', { room: 'project', waiting: 1 })]);
    expect(stops.map((s) => s.floor.id)).toEqual(['p2', 'p1', 'staff', 'b', 'a']);
    expect(stops.map((s) => s.no)).toEqual([null, null, null, 2, 1]);
    expect(stops.filter((s) => s.heading).map((s) => s.floor.id)).toEqual(['p2', 'staff', 'b']);
  });

  test('badges: needs you and working, never negative', () => {
    expect(stopBadges(floor('a', { waiting: 2, busy: 3 }))).toEqual({ needsYou: 2, working: 3 });
    expect(stopBadges(floor('a', { waiting: -1 }))).toEqual({ needsYou: 0, working: 0 });
  });

  test('needs you elsewhere leaves out the floor you are on and floors being cloned', () => {
    const floors = [floor('a', { waiting: 2 }), floor('b', { waiting: 1 }), floor('c', { waiting: 5, cloning: true })];
    expect(needsYouElsewhere(floors, 'a')).toBe(1);
    expect(needsYouElsewhere(floors, null)).toBe(3);
  });
});
