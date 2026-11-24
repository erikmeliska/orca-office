import { describe, expect, it } from 'vitest';
import { ROOF } from '@orca-office/shared/office/rooftop';
import { DESK_BY_ID } from '@orca-office/shared/office/layout';
import { FLOORS, StubSession, floorView } from './stub.js';

const session = (q = '') => new StubSession('me', new URLSearchParams(q));

describe('stub office', () => {
  it('has two floors, four desks or more and every state the office shows', () => {
    expect(FLOORS.length).toBeGreaterThanOrEqual(2);
    const all = FLOORS.flatMap((f) => f.workers);
    expect(new Set(FLOORS[0]!.workers.map((w) => w.deskId)).size).toBeGreaterThanOrEqual(4);
    for (const s of ['working', 'needs_input', 'done'] as const) expect(all.some((w) => w.status === s)).toBe(true);
  });

  it('seats every worker at a real desk, one per desk on a floor', () => {
    for (const f of FLOORS) {
      for (const w of f.workers) expect(DESK_BY_ID.has(w.deskId), w.deskId).toBe(true);
      expect(new Set(f.workers.map((w) => w.deskId)).size).toBe(f.workers.length);
    }
  });

  it('welcomes the page onto the first floor, in the elevator, as itself', () => {
    const w = session('name=Erik&color=%23112233').welcome();
    if (w.t !== 'welcome') throw new Error(w.t);
    expect(w.you).toBe('me');
    expect(w.floor).toBe(FLOORS[0]!.info.id);
    expect(w.floors.map((f) => f.id)).toEqual(FLOORS.map((f) => f.info.id));
    expect(w.peers).toEqual([expect.objectContaining({ id: 'me', name: 'Erik', color: '#112233', floor: FLOORS[0]!.info.id })]);
    expect(w.workers).toHaveLength(FLOORS[0]!.workers.length);
    expect(w.floors[0]).toMatchObject({ busy: 2, waiting: 2 });
  });

  it('puts the page back where it stood on the floor it was on', () => {
    const w = session(`floor=${FLOORS[1]!.info.id}&x=1&y=0&z=2&rotY=0.5`).welcome();
    if (w.t !== 'welcome') throw new Error(w.t);
    expect(w.floor).toBe(FLOORS[1]!.info.id);
    expect(w.peers[0]).toMatchObject({ x: 1, z: 2, rotY: 0.5 });
  });

  it('rides to another floor or the roof, and ignores floors that are not there', () => {
    const s = session();
    const [enter] = s.handle({ t: 'floor.go', floor: FLOORS[1]!.info.id });
    expect(enter).toMatchObject({ t: 'floor.enter', floor: FLOORS[1]!.info.id });
    expect(s.handle({ t: 'floor.go', floor: 'nowhere' })).toEqual([]);
    expect(s.handle({ t: 'floor.go', floor: ROOF })[0]).toMatchObject({ t: 'floor.enter', floor: ROOF, workers: [], dog: null });
  });

  it('answers a ping with the office clock', () => {
    const [pong] = session().handle({ t: 'ping', at: 12 });
    expect(pong).toMatchObject({ t: 'pong', at: 12 });
  });

  it('moves the working workers on to their next action each tick', () => {
    const s = session();
    const before = floorView(FLOORS[0]!.info.id).workers.filter((w) => w.action).map((w) => w.action);
    const after = s.tick().map((m) => (m.t === 'worker.update' ? m.worker.action : undefined));
    expect(after).toHaveLength(before.length);
    expect(after).not.toEqual(before);
  });
});
