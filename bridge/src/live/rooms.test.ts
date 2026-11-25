import { describe, expect, test } from 'vitest';
import { LiveModel, STAFF_FLOOR, roomFloorId } from './model.js';
import type { CliAgent, OrcaWorkspace } from './orca.js';
import type { OrcaRun } from './runs.js';
import type { OrcaWorktree } from './worktrees.js';

// Made-up repos, worktrees, Runs and mail.
const NOW = Date.parse('2026-11-24T12:00:00Z');
const ws = (id: string, project: string, path: string, over: Partial<OrcaWorkspace> = {}): OrcaWorkspace => ({ id, kind: 'worktree', name: id, project, projectId: `p-${project}`, path, branch: id, hostId: 'local', state: 'active', unread: false, lastActivityAt: 1, ...over });
const agent = (paneKey: string, path: string, over: Partial<CliAgent> = {}): CliAgent => ({ paneKey, sessionId: `s-${paneKey}`, kind: 'terminal', agent: 'claude', state: 'working', worktreeId: `repo::${path}`, workspace: 'w', repo: null, hostId: 'local', bubble: null, updatedAt: 1, ...over });
const wt = (id: string, repoId: string, path: string, over: Partial<OrcaWorktree> = {}): OrcaWorktree => ({ id, repoId, path, hostId: 'local', name: path.split('/').pop()!, branch: null, links: [], parentId: null, childIds: [], ...over });
const run = (over: Partial<OrcaRun> = {}): OrcaRun => ({
  id: 'run_a',
  objective: 'Made-up objective',
  coordinatorHandle: null,
  legacy: false,
  updatedAt: NOW - 1000,
  tasks: [
    { id: 't1', status: 'dispatched', title: 'Made-up web task' },
    { id: 't2', status: 'completed', title: 'Made-up api task' },
  ],
  gates: [],
  workers: [
    { dispatchId: 'ctx_1', taskId: 't1', state: 'running', workspace: 'repo-web::/code/web/a', host: 'local' },
    { dispatchId: 'ctx_2', taskId: 't2', state: 'succeeded', workspace: 'repo-api::/code/api/b', host: 'local' },
  ],
  ...over,
});

function office() {
  const m = new LiveModel();
  m.applyWorkspaces([ws('a', 'web', '/code/web/a'), ws('b', 'api', '/code/api/b'), { ...ws('folder:rb', 'x', '/home/u/.orca/bots/releasebot'), kind: 'folder', name: 'ReleaseBot', project: null }]);
  m.applyAgents('local', [agent('pa', '/code/web/a'), agent('pb', '/code/api/b', { state: 'blocked' })], NOW);
  return m;
}

describe('project rooms (#29, #30)', () => {
  test('a live Run is a room on the roof: head empty with a sign when Orca names no coordinator, a seat per worker mirroring its desk', () => {
    const m = office();
    m.applyRuns([run()], NOW);
    const b = m.building();
    const room = b.floors.find((f) => f.info.room === 'project')!;
    expect(room.info.id).toBe(roomFloorId('run:run_a'));
    expect(room.info.name).toBe('Made-up objective');
    const labels = Object.values(room.plan.labels).map((l) => l.text);
    expect(labels).toContain('👑 Coordinator unknown');
    expect(labels).toContain('🛠️ a');
    expect(labels).toContain('✅ b');
    // The two figures from downstairs, same names and states, own ids.
    const web = b.floors.find((f) => f.info.name === 'web')!.workers[0]!;
    const mirrored = room.workers.find((w) => w.name === web.name)!;
    expect(mirrored.status).toBe('working');
    expect(mirrored.id).not.toBe(web.id);
    expect(room.workers.map((w) => w.status).sort()).toEqual(['needs_input', 'working']);
    expect(room.info).toMatchObject({ busy: 1, waiting: 1 });
    expect(b.projects[room.info.id]).toMatchObject({ source: 'run', coordinator: null, tasks: [{ id: 't1', status: 'dispatched' }, { id: 't2', status: 'completed' }] });
    // Actions on the mirrored figure reach the same agent.
    expect(m.target(mirrored.id)?.paneKey).toBe('pa');
  });

  test('pending gates count as needing you and point at the task’s desk', () => {
    const m = office();
    m.applyRuns([run({ gates: [{ id: 'g1', taskId: 't1', question: 'Ship the made-up thing?', options: ['yes', 'no'] }] })], NOW);
    const b = m.building();
    const room = b.floors.find((f) => f.info.room === 'project')!;
    expect(room.info.waiting).toBe(2);
    const gate = b.projects[room.info.id]!.gates[0]!;
    expect(gate.question).toBe('Ship the made-up thing?');
    expect(m.deskWorkspace(room.info.id, gate.seat!)?.id).toBe('a');
  });

  test('an old finished Run is not a room', () => {
    const m = office();
    m.applyRuns([run({ tasks: [{ id: 't1', status: 'completed', title: null }], updatedAt: NOW - 5 * 3600_000 })], NOW);
    expect(m.building().floors.some((f) => f.info.room === 'project')).toBe(false);
  });

  test('a bot that mails a Run’s worker coordinates it: it sits at the head and its Staff office says where it went (#33)', () => {
    const m = office();
    m.applyBots([{ id: 'b1', name: 'ReleaseBot', agent: 'claude', paused: false, specialty: null }]);
    m.applyAgents('local', [agent('pa', '/code/web/a'), agent('pb', '/code/api/b'), agent('pbot', '', { kind: 'chat', worktreeId: 'folder:rb', workspace: 'ReleaseBot', sessionId: 'sess-bot' })], NOW);
    m.applyRuns([run()], NOW);
    m.applyInbox([{ id: 'm1', kind: null, from: 'orca_session_id:sess-bot', to: 'dispatch:ctx_1', subject: null, dispatchId: null, taskId: null }], NOW);
    const b = m.building();
    const room = b.floors.find((f) => f.info.room === 'project')!;
    expect(room.workers.some((w) => w.name === 'ReleaseBot')).toBe(true);
    expect(b.projects[room.info.id]!.coordinator).toEqual({ name: 'ReleaseBot', bot: true });
    const staff = b.floors.find((f) => f.info.id === STAFF_FLOOR)!;
    expect(staff.workers.some((w) => w.name === 'ReleaseBot')).toBe(false);
    expect(Object.values(staff.plan.labels)[0]!.text).toBe('🤖 ReleaseBot → 🏗️ roof');
    // The Run is over: back home.
    m.applyRuns([run({ tasks: [{ id: 't1', status: 'completed', title: null }], updatedAt: NOW - 5 * 3600_000 })], NOW);
    const after = m.building();
    expect(after.floors.find((f) => f.info.id === STAFF_FLOOR)!.workers.some((w) => w.name === 'ReleaseBot')).toBe(true);
  });

  test('lineage fallback: a parent with children in two repos is a room; with no Run covering it', () => {
    const m = office();
    m.applyWorktrees([wt('repo-web::/code/web/a', 'repo-web', '/code/web/a', { childIds: ['repo-api::/code/api/b'] }), wt('repo-api::/code/api/b', 'repo-api', '/code/api/b', { parentId: 'repo-web::/code/web/a' })]);
    let b = m.building();
    const room = b.floors.find((f) => f.info.room === 'project')!;
    expect(b.projects[room.info.id]).toMatchObject({ source: 'lineage', objective: 'a', members: ['b'] });
    expect(Object.values(room.plan.labels).map((l) => l.text)).toContain('👑 a');
    // A Run over the same worktrees replaces it.
    m.applyRuns([run()], NOW);
    b = m.building();
    expect(b.floors.filter((f) => f.info.room === 'project').map((f) => b.projects[f.info.id]!.source)).toEqual(['run']);
  });

  test('a lineage in one repo with one child is no room', () => {
    const m = office();
    m.applyWorktrees([wt('repo-web::/code/web/a', 'repo-web', '/code/web/a', { childIds: ['repo-web::/code/web/c'] }), wt('repo-web::/code/web/c', 'repo-web', '/code/web/c', { parentId: 'repo-web::/code/web/a' })]);
    expect(m.building().floors.some((f) => f.info.room === 'project')).toBe(false);
  });
});

describe('deliveries (#34)', () => {
  test('nothing for what was there at the first read; then new mail and dispatches, in the room and at the desk downstairs', () => {
    const m = office();
    m.applyRuns([run()], NOW);
    m.applyInbox([{ id: 'old', kind: 'worker_done', from: 'structworker_1', to: 'run:run_a', subject: 'Old', dispatchId: 'ctx_2', taskId: 't2' }], NOW);
    m.building();
    expect(m.takeHandoffs()).toEqual([]);
    m.applyInbox(
      [
        { id: 'old', kind: 'worker_done', from: 'structworker_1', to: 'run:run_a', subject: 'Old', dispatchId: 'ctx_2', taskId: 't2' },
        { id: 'new', kind: 'worker_done', from: 'structworker_1', to: 'run:run_a', subject: 'Made-up task done', dispatchId: 'ctx_1', taskId: 't1' },
      ],
      NOW,
    );
    const b = m.building();
    const room = b.floors.find((f) => f.info.room === 'project')!;
    const out = m.takeHandoffs();
    expect(out).toHaveLength(2);
    const [inRoom, atDesk] = out;
    expect(inRoom).toMatchObject({ floor: room.info.id, kind: 'worker_done', subject: 'Made-up task done' });
    expect(inRoom!.to).toBe(Object.entries(room.plan.labels).find(([, l]) => l.text.startsWith('👑'))![0]);
    expect(inRoom!.from).not.toBeNull();
    expect(atDesk).toMatchObject({ floor: b.floors.find((f) => f.info.name === 'web')!.info.id, to: null });
    expect(m.takeHandoffs()).toEqual([]);
    // A new dispatch: from the head down to the worker.
    m.applyRuns([run({ workers: [...run().workers, { dispatchId: 'ctx_3', taskId: 't2', state: 'running', workspace: 'repo-api::/code/api/b', host: 'local' }] })], NOW);
    m.building();
    const d = m.takeHandoffs();
    expect(d[0]).toMatchObject({ kind: 'dispatch', subject: 'Made-up api task', to: expect.any(String) });
    expect(d[1]).toMatchObject({ from: null });
  });
});

describe('who waits for you in the whole building (M6 A1, A2)', () => {
  test('agents asking on every floor and the open decision gates, longest first; a room’s mirrored figures only once', () => {
    const m = office();
    m.applyRuns([run({ gates: [{ id: 'g1', taskId: 't1', question: 'Made-up question?', options: ['Yes', 'No'] }] })], NOW + 5_000);
    m.tick(NOW + 6_000);
    const b = m.building();
    expect(b.waiting.map((w) => [w.kind, w.floorName, w.name, w.ask])).toEqual([
      ['agent', 'api', 'b', 'Waiting for you'],
      ['gate', 'Made-up objective', 'Decision', 'Made-up question?'],
    ]);
    const gate = b.waiting[1]!;
    expect(gate).toMatchObject({ key: 'gate:g1', workerId: null, since: NOW + 5_000 });
    expect(gate.deskId).toBeTruthy();
    // The time a gate was first seen stays put.
    m.applyRuns([run({ updatedAt: NOW, gates: [{ id: 'g1', taskId: 't1', question: 'Made-up question?', options: [] }] })], NOW + 60_000);
    expect(m.building().waiting[1]!.since).toBe(NOW + 5_000);
  });
});
