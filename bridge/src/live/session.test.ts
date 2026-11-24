import { expect, test } from 'vitest';
import { LiveModel } from './model.js';
import type { OrcaWorkspace } from './orca.js';
import { LiveSession } from './session.js';

// Made-up data only.
const ws = (id: string): OrcaWorkspace => ({ id, kind: 'worktree', name: id, project: 'demo', projectId: 'proj-demo', path: `/code/demo/${id}`, branch: id, hostId: 'local', state: 'active', unread: false, lastActivityAt: 1 });
const agent = (paneKey: string, state: 'working' | 'done' | 'blocked') => ({ paneKey, kind: 'terminal' as const, agent: 'claude', state, worktreeId: 'r::/code/demo/a', workspace: 'a', repo: 'demo', hostId: 'local', bubble: null, updatedAt: 1 });

test('a page arrives on the busiest floor and then hears only what changed there', () => {
  const m = new LiveModel();
  m.applyWorkspaces([ws('a')]);
  m.applyAgents('local', [agent('p1', 'working')], 0);
  const s = new LiveSession('me', new URLSearchParams(), m.building());
  const [welcome, orca] = s.welcome(m.building(), 'test', true);
  expect(welcome).toMatchObject({ t: 'welcome', floor: s.peer.floor, workers: [{ status: 'working' }] });
  expect(orca).toEqual({ t: 'orca', online: true });
  expect(s.update(m.building())).toEqual([]);
  m.applyStatus({ paneKey: 'p1', workspaceListId: 'a', terminalId: 't', state: 'blocked', at: 5 });
  const msgs = s.update(m.building());
  expect(msgs.map((x) => x.t)).toEqual(['floors', 'worker.update', 'plan']);
  m.applyAgents('local', [], 10);
  expect(s.update(m.building()).map((x) => x.t)).toEqual(['floors', 'worker.remove', 'plan']);
});

test('a page that came before Orca had anything is let in once a floor exists', () => {
  const m = new LiveModel();
  const s = new LiveSession('me', new URLSearchParams(), m.building());
  expect(s.peer.floor).toBeUndefined();
  m.applyWorkspaces([ws('a')]);
  expect(s.update(m.building()).map((x) => x.t)).toEqual(['floors', 'floor.enter']);
});

test('floor.go to an unknown floor is ignored', () => {
  const m = new LiveModel();
  m.applyWorkspaces([ws('a')]);
  const s = new LiveSession('me', new URLSearchParams(), m.building());
  expect(s.handle({ t: 'floor.go', floor: 'nope' }, m.building())).toEqual([]);
});
