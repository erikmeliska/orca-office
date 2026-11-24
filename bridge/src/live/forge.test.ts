import { expect, test, vi } from 'vitest';
import { LiveModel } from './model.js';
import { LiveSession, wallBoards } from './session.js';
import { boardOf, parseForgeHosts, setForgeHosts, FORGE_RETRY_MS, FORGE_TTL_MS, ForgeBoards, ForgeError, ghAdapter, glabAdapter, parseRemote, runCli, type ForgeAdapter, type ForgeTarget, type RunCli } from './forge.js';
import type { OrcaWorkspace } from './orca.js';

// Made-up repositories, issues and pull requests only.

test('git remotes name their forge repository; anything else is no forge', () => {
  expect(parseRemote('git@github.com:acme/widgets.git')).toEqual({ kind: 'github', host: 'github.com', path: 'acme/widgets' });
  expect(parseRemote('https://github.com/acme/widgets')).toEqual({ kind: 'github', host: 'github.com', path: 'acme/widgets' });
  expect(parseRemote('https://gitlab.com/acme/tools/widgets.git')).toEqual({ kind: 'gitlab', host: 'gitlab.com', path: 'acme/tools/widgets' });
  // Self-hosted forges only when named: a look-alike host never gets a CLI call (and so no enterprise token).
  expect(parseRemote('ssh://git@gitlab.example.com:2222/g/sub/r.git')).toBeNull();
  expect(parseRemote('git@github.example.com:o/r.git')).toBeNull();
  setForgeHosts(parseForgeHosts('gitlab:gitlab.example.com, github:GitHub.Example.com, bogus, ftp:x.com'));
  expect(parseRemote('ssh://git@gitlab.example.com:2222/g/sub/r.git')).toEqual({ kind: 'gitlab', host: 'gitlab.example.com', path: 'g/sub/r' });
  expect(parseRemote('git@github.example.com:o/r.git')).toEqual({ kind: 'github', host: 'github.example.com', path: 'o/r' });
  expect(parseRemote('git@x.com:o/r.git')).toBeNull();
  setForgeHosts(parseForgeHosts(undefined));
  expect(parseRemote('/Users/me/code/r.git')).toBeNull();
  expect(parseRemote('git@bitbucket.org:o/r.git')).toBeNull();
  expect(parseRemote('https://github.com/o/r/extra')).toBeNull();
  expect(parseRemote('file:///tmp/github.com/o/r')).toBeNull();
  expect(parseRemote('git@github.com:o/../r')).toBeNull();
  expect(parseRemote('git@github.com:-o/r')).not.toBeNull(); // a dash is passed after -R as one argument, never a flag of its own
});

test('gh is asked read-only, with -R and JSON, and its answer is cut to the board', async () => {
  const calls: string[][] = [];
  const run: RunCli = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === 'issue') return [{ number: 7, title: 'Made-up issue ' + 'x'.repeat(100), url: 'https://github.com/acme/widgets/issues/7' }, { number: 0, title: 'bad' }];
    return [{ number: 9, title: 'Made-up PR', url: 'javascript:alert(1)', headRefName: 'feat/x', isDraft: true }];
  };
  const lists = await ghAdapter(run, 'gh').list({ kind: 'github', host: 'github.com', path: 'acme/widgets' });
  expect(calls).toEqual([
    ['gh', 'issue', 'list', '-R', 'github.com/acme/widgets', '--state', 'open', '--limit', '30', '--json', 'number,title,url'],
    ['gh', 'pr', 'list', '-R', 'github.com/acme/widgets', '--state', 'open', '--limit', '30', '--json', 'number,title,url,headRefName,isDraft'],
  ]);
  expect(lists.issues).toHaveLength(1);
  expect(lists.issues[0]!.title.length).toBeLessThanOrEqual(60);
  expect(lists.pulls).toEqual([{ number: 9, title: 'Made-up PR', branch: 'feat/x', draft: true }]);
});

test('glab is asked with the repository url and only open items are kept', async () => {
  const calls: string[][] = [];
  const run: RunCli = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === 'issue') return [{ iid: 3, title: 'Made-up', web_url: 'https://gitlab.com/g/r/-/issues/3', state: 'opened' }, { iid: 4, title: 'Closed', state: 'closed' }];
    return [{ iid: 5, title: 'Made-up MR', web_url: 'https://gitlab.com/g/r/-/merge_requests/5', source_branch: 'fix', state: 'opened' }];
  };
  const lists = await glabAdapter(run, 'glab').list({ kind: 'gitlab', host: 'gitlab.com', path: 'g/r' });
  expect(calls[0]).toEqual(['glab', 'issue', 'list', '-R', 'https://gitlab.com/g/r', '--per-page', '30', '--output', 'json']);
  expect(calls[1]).toEqual(['glab', 'mr', 'list', '-R', 'https://gitlab.com/g/r', '--per-page', '30', '--output', 'json']);
  expect(lists.issues.map((i) => i.number)).toEqual([3]);
  expect(lists.pulls).toEqual([{ number: 5, title: 'Made-up MR', url: 'https://gitlab.com/g/r/-/merge_requests/5', branch: 'fix' }]);
});

test('a missing CLI and a failing one are told apart, without their output', async () => {
  await expect(runCli()('/nonexistent/orca-office-gh', ['x'])).rejects.toMatchObject({ code: 'missing' });
  await expect(runCli()(process.execPath, ['-e', 'console.error("To get started, run: gh auth login"); process.exit(4)'])).rejects.toMatchObject({ code: 'auth' });
  const failed = await runCli()(process.execPath, ['-e', 'console.error("secret-ish output"); process.exit(1)']).catch((e: Error) => e);
  expect(failed).toBeInstanceOf(ForgeError);
  expect((failed as ForgeError).code).toBe('failed');
  expect(String((failed as Error).message)).not.toContain('secret');
});

const target = (over: Partial<ForgeTarget> = {}): ForgeTarget => ({ floor: 'f-demo', dir: '/code/demo/a', branches: new Set(['feat/x']), linked: new Set(['issue:7']), ...over });

test('the queue is what no worktree works on: not linked in Orca and no worktree on its branch', () => {
  const b = boardOf({ kind: 'github', host: 'github.com', path: 'acme/widgets' }, 'gh', 'ok', {
    issues: [{ number: 7, title: 'Linked' }, { number: 8, title: 'Free', url: 'https://github.com/acme/widgets/issues/8' }],
    pulls: [{ number: 9, title: 'On a worktree branch', branch: 'feat/x' }, { number: 10, title: 'Nobody', branch: 'other' }],
  }, target(), 5);
  expect(b.issues.map((i) => [i.ref, i.worktree])).toEqual([['#7', true], ['#8', false]]);
  expect(b.pulls.map((i) => [i.ref, i.worktree])).toEqual([['#9', true], ['#10', false]]);
  expect(b.queue.map((i) => i.ref)).toEqual(['#8', '#10']);
  expect(b.note).toBeUndefined();
  const gl = boardOf({ kind: 'gitlab', host: 'gitlab.com', path: 'g/r' }, 'glab', 'ok', { issues: [], pulls: [{ number: 4, title: 'MR' }] }, target({ linked: new Set(['pr:4']) }), 5);
  expect(gl.pulls[0]).toMatchObject({ kind: 'mr', ref: '!4', worktree: true });
});

function boards(adapter: Partial<ForgeAdapter> & { list: ForgeAdapter['list'] }, remote = 'git@github.com:acme/widgets.git') {
  let now = 1_000;
  const changed = vi.fn();
  const remoteFn = vi.fn(async () => remote);
  const fb = new ForgeBoards({ adapters: [{ kind: 'github', cli: 'gh', ...adapter }], remote: remoteFn, now: () => now, changed });
  return { fb, changed, remoteFn, tick: (ms: number) => (now += ms) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('a board is read once, kept for its TTL, and read again after it', async () => {
  const list = vi.fn(async () => ({ issues: [{ number: 1, title: 'A' }], pulls: [] }));
  const { fb, changed, remoteFn, tick } = boards({ list });
  expect(fb.board(target()).status).toBe('loading');
  fb.board(target());
  await flush();
  expect(list).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledWith('f-demo');
  expect(fb.board(target())).toMatchObject({ status: 'ok', provider: 'github', repo: 'acme/widgets', queue: [{ ref: '#1' }] });
  tick(FORGE_TTL_MS - 1);
  fb.board(target());
  await flush();
  expect(list).toHaveBeenCalledTimes(1);
  tick(2);
  fb.board(target());
  await flush();
  expect(list).toHaveBeenCalledTimes(2);
  expect(remoteFn).toHaveBeenCalledTimes(1);
});

test('not logged in: the board says so politely, keeps the last good lists, and retries after a minute', async () => {
  let fail = false;
  const list = vi.fn(async () => {
    if (fail) throw new ForgeError('auth');
    return { issues: [{ number: 1, title: 'A' }], pulls: [] };
  });
  const { fb, tick } = boards({ list });
  fb.board(target());
  await flush();
  fail = true;
  tick(FORGE_TTL_MS + 1);
  fb.board(target());
  await flush();
  const b = fb.board(target());
  expect(b.status).toBe('auth');
  expect(b.note).toBe("`gh` isn't logged in: run `gh auth login` to see this repo's board.");
  expect(b.issues).toHaveLength(1);
  tick(FORGE_RETRY_MS - 1);
  fb.board(target());
  await flush();
  expect(list).toHaveBeenCalledTimes(2);
  tick(2);
  fb.board(target());
  await flush();
  expect(list).toHaveBeenCalledTimes(3);
});

test('no GitHub/GitLab remote: no CLI is run, the board says why', async () => {
  const list = vi.fn();
  const { fb } = boards({ list }, '/srv/git/r.git');
  fb.board(target());
  await flush();
  expect(list).not.toHaveBeenCalled();
  expect(fb.board(target())).toMatchObject({ status: 'no_remote', provider: null, note: expect.stringContaining('no remote') });
});

test('wall boards: the forge once read, else the desks’ links with the board’s note', () => {
  const links = { 'desk-1': [{ provider: 'github' as const, kind: 'pr' as const, ref: '#12', url: 'https://github.com/o/r/pull/12' }] };
  const auth = boardOf({ kind: 'github', host: 'github.com', path: 'o/r' }, 'gh', 'auth', null, target(), 5);
  const w = wallBoards(links, auth);
  expect(w.pulls.items.map((p) => p.number)).toEqual([12]);
  expect(w.issues).toMatchObject({ items: [], error: expect.stringContaining('gh auth login') });
  const ok = boardOf({ kind: 'github', host: 'github.com', path: 'o/r' }, 'gh', 'ok', { issues: [{ number: 7, title: 'Linked' }], pulls: [] }, target(), 5);
  const w2 = wallBoards(links, ok);
  expect(w2.issues.items).toEqual([expect.objectContaining({ number: 7, taken: true })]);
  expect(w2.pulls.items).toEqual([]);
});

const ws = (id: string, over: Partial<OrcaWorkspace> = {}): OrcaWorkspace => ({ id, kind: 'worktree', name: id, project: 'demo', projectId: 'p-demo', path: `/code/demo/${id}`, branch: id, hostId: 'local', state: 'active', unread: false, lastActivityAt: 1, ...over });

test('a floor’s forge target: its repository’s worktrees, their branches and Orca’s links', () => {
  const m = new LiveModel();
  m.applyWorkspaces([ws('a'), ws('b'), ws('x', { project: 'other', path: '/code/other/x' })]);
  m.applyWorktrees([
    { id: 'r::/code/demo/a', repoId: 'r', path: '/code/demo/a', hostId: 'local', name: 'a', branch: 'main', links: [{ provider: 'github', kind: 'issue', ref: '#7' }], parentId: null, childIds: [] },
    { id: 'r::/code/demo/c', repoId: 'r', path: '/code/demo/c', hostId: 'local', name: 'c', branch: 'feat/x', links: [{ provider: 'linear', kind: 'issue', ref: 'ENG-1' }], parentId: null, childIds: [] },
    { id: 'q::/code/other/x', repoId: 'q', path: '/code/other/x', hostId: 'local', name: 'x', branch: 'main', links: [], parentId: null, childIds: [] },
  ]);
  const floor = m.building().floors.find((f) => f.info.name === 'demo')!.info.id;
  const t = m.forgeTarget(floor)!;
  expect(t.dir).toBe('/code/demo/a');
  expect([...t.branches]).toEqual(['main', 'feat/x']);
  expect([...t.linked]).toEqual(['issue:7']);
  expect(m.forgeTarget('f-nowhere')).toBeNull();
});

test('a page gets its floor’s board on arriving, and the walls and queue again when the board changes', () => {
  const m = new LiveModel();
  m.applyWorkspaces([ws('a')]);
  let board = boardOf(null, '', 'loading', null, target(), 0);
  const s = new LiveSession('me', new URLSearchParams(), m.building(), () => board);
  const first = s.welcome(m.building(), 'test', true);
  expect(first.find((x) => x.t === 'orca.forge')).toMatchObject({ board: { status: 'loading' } });
  expect(s.forgeUpdate(m.building())).toEqual([]);
  board = boardOf({ kind: 'github', host: 'github.com', path: 'o/r' }, 'gh', 'ok', { issues: [{ number: 8, title: 'Free' }], pulls: [] }, target(), 9);
  const msgs = s.forgeUpdate(m.building());
  expect(msgs.map((x) => x.t)).toEqual(['gh.pulls', 'gh.issues', 'orca.forge']);
  expect(s.update(m.building())).toEqual([]);
});
