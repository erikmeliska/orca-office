import { describe, expect, test } from 'vitest';
import { ACTION_MS, DONE_DEBOUNCE_MS, HELPER_MAX_MS, LiveModel, MAX_SEATS, PROVISIONAL_MS, STAFF_FLOOR, allocate, floorId } from './model.js';
import { parseAgentList, parseBots, parseStatusEvent, parseToolHook, parseWorkspaces, type CliAgent, type OrcaWorkspace } from './orca.js';

// Everything here is made up: fake repos, paths and messages.

const ws = (id: string, over: Partial<OrcaWorkspace> = {}): OrcaWorkspace => ({
  id,
  kind: 'worktree',
  name: id,
  project: 'demo-web',
  projectId: 'proj-web',
  path: `/code/demo-web/${id}`,
  branch: id,
  hostId: 'local',
  state: 'active',
  unread: false,
  lastActivityAt: 1,
  ...over,
});

const agent = (paneKey: string, wsPath: string, over: Partial<CliAgent> = {}): CliAgent => ({
  paneKey,
  kind: 'terminal',
  agent: 'claude',
  state: 'working',
  worktreeId: `repo-1::${wsPath}`,
  workspace: 'w',
  repo: 'demo-web',
  hostId: 'local',
  bubble: null,
  updatedAt: 100,
  ...over,
});

function floor(m: LiveModel, name: string) {
  return m.building().floors.find((f) => f.info.name === name);
}

describe('mapping Orca onto the office', () => {
  test('floor = repo, desk = worktree, figure = agent; an open worktree without agents is an empty desk with a sign', () => {
    const m = new LiveModel();
    m.applyWorkspaces([ws('a'), ws('b'), ws('c', { project: 'demo-api', path: '/code/demo-api/c' }), ws('idle', { state: 'inactive' })]);
    m.applyAgents('local', [agent('p1', '/code/demo-web/a'), agent('p2', '/code/demo-api/c', { state: 'blocked', repo: 'demo-api' })], 0);
    const b = m.building();
    expect(b.floors.map((f) => f.info.name)).toEqual(['demo-api', 'demo-web']);
    const web = floor(m, 'demo-web')!;
    expect(web.workers).toHaveLength(1);
    expect(web.workers[0]!.status).toBe('working');
    expect(Object.values(web.plan.labels).map((l) => l.text).sort()).toEqual(['a', 'b']);
    const api = floor(m, 'demo-api')!;
    expect(api.workers[0]!.status).toBe('needs_input');
    expect(api.info.waiting).toBe(1);
    expect(web.info.busy).toBe(1);
  });

  test('ids, names and colors are stable per agent', () => {
    const m = new LiveModel();
    m.applyWorkspaces([ws('a')]);
    m.applyAgents('local', [agent('p1', '/code/demo-web/a')], 0);
    const w1 = floor(m, 'demo-web')!.workers[0]!;
    const m2 = new LiveModel();
    m2.applyWorkspaces([ws('a')]);
    m2.applyAgents('local', [agent('p1', '/code/demo-web/a')], 50);
    const w2 = floor(m2, 'demo-web')!.workers[0]!;
    expect([w2.id, w2.name, w2.color]).toEqual([w1.id, w1.name, w1.color]);
  });

  test('a bubble is the agent card body; a chat agent is tagged and has no terminal', () => {
    const m = new LiveModel();
    m.applyWorkspaces([ws('a')]);
    m.applyAgents('local', [agent('p1', '/code/demo-web/a', { kind: 'chat', bubble: 'Fixed the flaky test' })], 0);
    const w = floor(m, 'demo-web')!.workers[0]!;
    expect(w.task).toEqual({ name: '💬 a', summary: 'Fixed the flaky test' });
    expect(w.provider).toBe('claude');
  });

  test('an agent closed in Orca leaves', () => {
    const m = new LiveModel();
    m.applyWorkspaces([ws('a')]);
    m.applyAgents('local', [agent('p1', '/code/demo-web/a')], 0);
    m.applyAgents('local', [], 10);
    expect(floor(m, 'demo-web')!.workers).toHaveLength(0);
  });
});

describe('status events', () => {
  function setup() {
    const m = new LiveModel();
    m.applyWorkspaces([ws('a')]);
    m.applyAgents('local', [agent('p1', '/code/demo-web/a')], 0);
    return m;
  }
  const status = () => (m: LiveModel) => floor(m, 'demo-web')!.workers[0]!.status;

  test('done shows only after the debounce, and a working within it cancels it', () => {
    const m = setup();
    const st = status();
    m.applyStatus({ paneKey: 'p1', workspaceListId: 'a', terminalId: 't1', state: 'done', at: 1000 });
    m.tick(1000 + DONE_DEBOUNCE_MS - 1);
    expect(st(m)).toBe('working');
    m.applyStatus({ paneKey: 'p1', workspaceListId: 'a', terminalId: 't1', state: 'working', at: 1500 });
    m.tick(1000 + DONE_DEBOUNCE_MS + 10);
    expect(st(m)).toBe('working');
    m.applyStatus({ paneKey: 'p1', workspaceListId: 'a', terminalId: 't1', state: 'done', at: 3000 });
    m.tick(3000 + DONE_DEBOUNCE_MS);
    expect(st(m)).toBe('done');
  });

  test('repeated states change nothing', () => {
    const m = setup();
    const v = m.version;
    m.applyStatus({ paneKey: 'p1', workspaceListId: 'a', terminalId: 't1', state: 'working', at: 5 });
    m.applyStatus({ paneKey: 'p1', workspaceListId: 'a', terminalId: 't1', state: 'working', at: 6 });
    expect(m.version).toBe(v);
  });

  test('blocked and waiting show at once as needs you', () => {
    const m = setup();
    m.applyStatus({ paneKey: 'p1', workspaceListId: 'a', terminalId: 't1', state: 'waiting', at: 5 });
    expect(status()(m)).toBe('needs_input');
  });

  test('an agent nobody listed yet sits down at once, asks for a CLI refresh, and leaves if it never shows up there', () => {
    const m = new LiveModel();
    m.applyWorkspaces([ws('a')]);
    expect(m.applyStatus({ paneKey: 'new', workspaceListId: 'a', terminalId: 't9', state: 'working', at: 0 })).toBe(true);
    expect(floor(m, 'demo-web')!.workers).toHaveLength(1);
    m.tick(PROVISIONAL_MS + 1);
    expect(floor(m, 'demo-web')!.workers).toHaveLength(0);
  });

  test('a provisional agent becomes a listed one', () => {
    const m = new LiveModel();
    m.applyWorkspaces([ws('a')]);
    m.applyStatus({ paneKey: 'new', workspaceListId: 'a', terminalId: 't9', state: 'working', at: 0 });
    m.applyAgents('local', [agent('new', '/code/demo-web/a', { bubble: 'hi' })], 100);
    m.tick(PROVISIONAL_MS + 1);
    expect(floor(m, 'demo-web')!.workers[0]!.task?.summary).toBe('hi');
  });
});

describe('tool hooks', () => {
  function setup() {
    const m = new LiveModel();
    m.applyWorkspaces([ws('a')]);
    m.applyAgents('local', [agent('p1', '/code/demo-web/a')], 0);
    m.applyStatus({ paneKey: 'p1', workspaceListId: 'a', terminalId: 't1', state: 'working', at: 1 });
    return m;
  }
  const w = (m: LiveModel) => floor(m, 'demo-web')!.workers[0]!;
  const hook = (tool: string, over = {}) => ({ terminalId: 't1', workspaceId: 'repo-1::/code/demo-web/a', tool, action: null, failed: false, callId: null, at: 10, ...over });

  test('tools become actions', () => {
    const m = setup();
    m.applyHook(hook('Read'));
    expect(w(m).action).toBe('read');
    m.applyHook(hook('Edit'));
    expect(w(m).action).toBe('edit');
    m.applyHook(hook('WebFetch'));
    expect(w(m).action).toBe('web');
    m.applyHook(hook('Bash', { action: 'test' }));
    expect([w(m).action, w(m).activity]).toEqual(['test', 'Bash']);
  });

  test('subagents are helpers by their parent until their call ends, or its turn does', () => {
    const m = setup();
    m.applySubagentStart(hook('Task', { callId: 'c1' }));
    m.applySubagentStart(hook('Task', { callId: 'c2' }));
    m.applySubagentStart(hook('Task', { callId: 'c2' }));
    m.applySubagentStart(hook('Task'));
    expect(w(m).helpers).toBe(2);
    m.applyHook(hook('Task', { callId: 'c1' }));
    expect(w(m).helpers).toBe(1);
    m.applyStatus({ paneKey: 'p1', workspaceListId: 'a', terminalId: 't1', state: 'blocked', at: 20 });
    expect(w(m).helpers).toBeUndefined();
    m.applyStatus({ paneKey: 'p1', workspaceListId: 'a', terminalId: 't1', state: 'working', at: 30 });
    m.applySubagentStart(hook('Agent', { callId: 'c3', at: 40 }));
    m.tick(40 + HELPER_MAX_MS + 1);
    expect(w(m).helpers).toBeUndefined();
  });

  test('failing test runs in a row turn into failing; a pass resets it', () => {
    const m = setup();
    m.applyHook(hook('Bash', { action: 'test', failed: true }));
    expect(w(m).action).toBe('test');
    m.applyHook(hook('Bash', { action: 'test', failed: true }));
    expect(w(m).action).toBe('failing');
    m.applyHook(hook('Bash', { action: 'test' }));
    expect(w(m).action).toBe('test');
  });

  test('an action fades after a while and goes when the agent stops working', () => {
    const m = setup();
    m.applyHook(hook('Read'));
    m.tick(10 + ACTION_MS + 1);
    expect(w(m).action).toBeUndefined();
    m.applyHook(hook('Read', { at: 20_000 }));
    m.applyStatus({ paneKey: 'p1', workspaceListId: 'a', terminalId: 't1', state: 'waiting', at: 20_001 });
    expect(w(m).action).toBeUndefined();
  });

  test('a hook from an unknown terminal falls back to the only working terminal agent at that worktree', () => {
    const m = new LiveModel();
    m.applyWorkspaces([ws('a')]);
    m.applyAgents('local', [agent('p1', '/code/demo-web/a')], 0);
    m.applyHook(hook('Edit', { terminalId: 'unknown' }));
    expect(w(m).action).toBe('edit');
  });
});

describe('seating', () => {
  test('up to four agents at one worktree sit side by side in one cluster; past that, +N on the sign', () => {
    const m = new LiveModel();
    m.applyWorkspaces([ws('a')]);
    m.applyAgents('local', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((k) => agent(k, '/code/demo-web/a')), 0);
    const f = floor(m, 'demo-web')!;
    expect(f.workers).toHaveLength(MAX_SEATS);
    expect(new Set(f.workers.map((w) => w.deskId))).toEqual(new Set(['desk-1', 'desk-2', 'desk-3', 'desk-4']));
    expect(Object.values(f.plan.labels)[0]!.text).toBe('a +2');
  });

  test('seats stay put when other desks come and go', () => {
    const m = new LiveModel();
    m.applyWorkspaces([ws('a'), ws('b')]);
    m.applyAgents('local', [agent('p1', '/code/demo-web/a'), agent('p2', '/code/demo-web/b')], 0);
    const before = Object.fromEntries(floor(m, 'demo-web')!.workers.map((w) => [w.id, w.deskId]));
    m.applyAgents('local', [agent('p1', '/code/demo-web/a', { state: 'blocked' }), agent('p2', '/code/demo-web/b'), agent('p3', '/code/demo-web/b')], 10);
    const after = Object.fromEntries(floor(m, 'demo-web')!.workers.map((w) => [w.id, w.deskId]));
    for (const [id, desk] of Object.entries(before)) expect(after[id]).toBe(desk);
  });

  test('allocate: the fullest cluster that fits, bean bags last', () => {
    const seats = allocate(new Map(), ['x', 'y'], new Map([['x', 3], ['y', 2]]));
    expect(seats.get('x')).toEqual(['desk-1', 'desk-2', 'desk-3']);
    expect(seats.get('y')).toEqual(['desk-5', 'desk-6']);
    const many = Array.from({ length: 40 }, (_, i) => `d${i}`);
    const all = allocate(new Map(), many, new Map(many.map((k) => [k, 1])));
    expect([...all.values()].flat().filter((s) => s.startsWith('beanbag-')).length).toBeGreaterThan(0);
    expect(all.size).toBe(20 + 12);
  });
});

describe('paired environments and bots', () => {
  test('a remote agent goes to its repo floor with a host tag', () => {
    const m = new LiveModel();
    m.applyWorkspaces([ws('a')]);
    m.applyAgents('pair.example', [agent('r1', '/srv/demo-web/feature', { hostId: 'pair.example', workspace: 'feature' })], 0);
    const f = floor(m, 'demo-web')!;
    expect(f.workers[0]!.task?.name).toBe('🌐 pair.example feature');
    expect(Object.values(f.plan.labels).some((l) => l.text === '🌐 feature')).toBe(true);
    // Each host's list replaces only its own agents.
    m.applyAgents('local', [], 5);
    expect(floor(m, 'demo-web')!.workers).toHaveLength(1);
  });

  test('bots sit on the Staff floor with a stable look and idle/working from their chats', () => {
    const m = new LiveModel();
    m.applyWorkspaces([ws('folder:rb', { kind: 'folder', name: 'ReleaseBot', project: null, path: '/home/u/.orca/bots/releasebot' })]);
    m.applyBots([
      { id: 'b2', name: 'SupportBot', agent: 'claude', paused: false, specialty: 'Answers support tickets' },
      { id: 'b1', name: 'ReleaseBot', agent: 'claude', paused: false, specialty: 'Ships releases' },
    ]);
    m.applyAgents('local', [agent('c1', '', { kind: 'chat', worktreeId: 'folder:rb', workspace: 'ReleaseBot', bubble: 'Tagging v1.2' })], 0);
    const b = m.building();
    expect(b.floors.map((f) => f.info.id)).toEqual([STAFF_FLOOR]);
    const staff = b.floors[0]!;
    const byName = Object.fromEntries(staff.workers.map((w) => [w.name, w]));
    expect(byName.ReleaseBot!.status).toBe('working');
    expect(byName.ReleaseBot!.task?.summary).toBe('Tagging v1.2');
    expect(byName.SupportBot!.status).toBe('idle');
    expect(byName.SupportBot!.task?.summary).toBe('Answers support tickets');
    expect(Object.values(staff.plan.labels).map((l) => l.text).sort()).toEqual(['🤖 ReleaseBot', '🤖 SupportBot']);
  });
});

describe('parsing Orca', () => {
  test('agent list: bubble cut to 120 chars, environments from hostScope, bad rows dropped', () => {
    const long = 'x'.repeat(500);
    const r = parseAgentList({
      ok: true,
      result: {
        agents: [
          { paneKey: 'p', kind: 'terminal', agent: 'claude', state: 'working', worktreeId: 'r::/a', workspace: 'a', repo: 'demo', hostId: 'local', title: 'secret title', lastAssistantMessage: long, updatedAt: 3 },
          { paneKey: 'q', state: 'nonsense' },
        ],
        hostScope: { omittedHostSelectors: [{ hostId: 'runtime:1', selector: '--environment pair.example' }] },
      },
    });
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0]!.bubble!.length).toBe(120);
    expect(JSON.stringify(r)).not.toContain('secret title');
    expect(r.environments).toEqual([{ hostId: 'runtime:1', name: 'pair.example' }]);
  });

  test('snapshot, status event, hook and bots', () => {
    expect(parseWorkspaces({ workspaces: [{ id: 'w', kind: 'worktree', name: 'n', path: '/p', branch: 'b', hostId: 'local', status: { state: 'working', unread: true, lastActivityAt: 2 } }, { id: 1 }] })).toEqual([
      { id: 'w', kind: 'worktree', name: 'n', project: null, projectId: null, path: '/p', branch: 'b', hostId: 'local', state: 'working', unread: true, lastActivityAt: 2 },
    ]);
    expect(parseStatusEvent({ paneKey: 'p', state: 'blocked', workspaceListId: 'w', terminalId: 't', title: 'private' }, 5)).toEqual({ paneKey: 'p', workspaceListId: 'w', terminalId: 't', state: 'blocked', at: 5 });
    expect(parseToolHook({ tool: 'Bash', terminalId: 't', workspaceId: 'r::/p', action: 'test', failed: true }, 1)).toMatchObject({ tool: 'Bash', action: 'test', failed: true });
    expect(parseBots({ result: { bots: [{ id: 'b', name: 'Bot', agent: 'claude', paused: false, specialty: 'Does things' }, { name: 'x' }] } })).toEqual([{ id: 'b', name: 'Bot', agent: 'claude', paused: false, specialty: 'Does things' }]);
  });

  test('floor ids are stable slugs', () => {
    expect(floorId('demo-web')).toBe(floorId('demo-web'));
    expect(floorId('demo-web')).toMatch(/^f-demo-web-[a-z0-9]+$/);
    expect(floorId('Demo Web')).not.toBe(floorId('demo-web'));
  });
});
