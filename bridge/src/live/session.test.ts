import { expect, test } from 'vitest';
import { LiveModel } from './model.js';
import type { OrcaWorkspace } from './orca.js';
import { LiveSession } from './session.js';

// Made-up data only.
const ws = (id: string): OrcaWorkspace => ({ id, kind: 'worktree', name: id, project: 'demo', projectId: 'proj-demo', path: `/code/demo/${id}`, branch: id, hostId: 'local', state: 'active', unread: false, lastActivityAt: 1 });
const agent = (paneKey: string, state: 'working' | 'done' | 'blocked') => ({ paneKey, sessionId: null, kind: 'terminal' as const, agent: 'claude', state, worktreeId: 'r::/code/demo/a', workspace: 'a', repo: 'demo', hostId: 'local', bubble: null, updatedAt: 1 });

test('a page arrives on the busiest floor and then hears only what changed there', () => {
  const m = new LiveModel();
  m.applyWorkspaces([ws('a')]);
  m.applyAgents('local', [agent('p1', 'working')], 0);
  const s = new LiveSession('me', new URLSearchParams(), m.building());
  const [welcome, orca, waiting, roster] = s.welcome(m.building(), 'test', true);
  expect(welcome).toMatchObject({ t: 'welcome', floor: s.peer.floor, workers: [{ status: 'working' }] });
  expect(orca).toEqual({ t: 'orca', online: true });
  expect(waiting).toEqual({ t: 'orca.waiting', items: [] });
  expect(roster).toMatchObject({ t: 'orca.roster', floors: [{ name: 'demo', workers: [{ name: 'a', status: 'working', branch: 'a' }] }] });
  expect(s.update(m.building())).toEqual([]);
  m.applyStatus({ paneKey: 'p1', workspaceListId: 'a', terminalId: 't', state: 'blocked', at: 5 });
  const msgs = s.update(m.building());
  // Who waits for you in the whole building (A1) comes first, then the floor's own news.
  expect(msgs.map((x) => x.t)).toEqual(['orca.waiting', 'orca.roster', 'floors', 'worker.update', 'plan']);
  expect(msgs[0]).toMatchObject({ items: [{ kind: 'agent', name: 'a', floorName: 'demo' }] });
  m.applyAgents('local', [], 10);
  expect(s.update(m.building()).map((x) => x.t)).toEqual(['orca.waiting', 'orca.roster', 'floors', 'worker.remove', 'plan']);
});

test('a page that came before Orca had anything is let in once a floor exists', () => {
  const m = new LiveModel();
  const s = new LiveSession('me', new URLSearchParams(), m.building());
  expect(s.peer.floor).toBeUndefined();
  m.applyWorkspaces([ws('a')]);
  expect(s.update(m.building()).map((x) => x.t)).toEqual(['orca.waiting', 'orca.roster', 'floors', 'floor.enter', 'orca.links', 'orca.project', 'orca.forge']);
});

test('floor.go to an unknown floor is ignored', () => {
  const m = new LiveModel();
  m.applyWorkspaces([ws('a')]);
  const s = new LiveSession('me', new URLSearchParams(), m.building());
  expect(s.handle({ t: 'floor.go', floor: 'nope' }, m.building())).toEqual([]);
});

test('the desks’ links (#32) come with the floor, again when they change, and fill the wall boards', () => {
  const m = new LiveModel();
  m.applyWorkspaces([ws('a')]);
  m.applyAgents('local', [agent('p1', 'working')], 0);
  const s = new LiveSession('me', new URLSearchParams(), m.building());
  const first = s.welcome(m.building(), 'test', true);
  expect(first.find((x) => x.t === 'orca.links')).toMatchObject({ t: 'orca.links', desks: {} });
  expect(first.find((x) => x.t === 'orca.project')).toEqual({ t: 'orca.project', floor: s.peer.floor, project: null });
  expect(first.at(-1)).toEqual({ t: 'orca.forge', floor: s.peer.floor, board: null });
  m.applyWorktrees([{ id: 'r::/code/demo/a', repoId: 'r', path: '/code/demo/a', hostId: 'local', name: 'a', branch: null, links: [{ provider: 'github', kind: 'pr', ref: '#12', url: 'https://github.com/o/r/pull/12', title: 'Made-up PR' }, { provider: 'github', kind: 'issue', ref: '#3' }], parentId: null, childIds: [] }]);
  const msgs = s.update(m.building());
  expect(msgs.map((x) => x.t)).toEqual(['plan', 'gh.pulls', 'gh.issues', 'orca.links']);
  const links = msgs.find((x) => x.t === 'orca.links') as { desks: Record<string, unknown[]> };
  const seats = Object.keys(links.desks);
  expect(seats.length).toBeGreaterThan(0);
  const pulls = msgs.find((x) => x.t === 'gh.pulls') as { state: { items: { number: number; url: string; title: string; state: string }[] } };
  expect(pulls.state.items).toEqual([expect.objectContaining({ number: 12, url: 'https://github.com/o/r/pull/12', title: 'Made-up PR', state: 'OPEN' })]);
  const plan = msgs.find((x) => x.t === 'plan') as { plan: { labels: Record<string, { pins?: string }> } };
  expect(Object.values(plan.plan.labels)[0]!.pins).toBe('🔀 #12 · 📌 #3');
  expect(s.update(m.building())).toEqual([]);
});
