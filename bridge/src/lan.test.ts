import { describe, expect, test } from 'vitest';
import { LAN_LIMITS } from '@orca-office/shared/office/protocol/lan';
import { lanConfig, lanHostAllowed, lanReply, lanStaticPath, lanUpgradeAllowed, lanView } from './lan.js';
import { LiveModel } from './live/model.js';
import type { CliAgent, OrcaWorkspace } from './live/orca.js';
import type { OrcaRun } from './live/runs.js';

// Made-up repos, agents and texts only.
const NOW = Date.parse('2026-11-24T12:00:00Z');
const SECRETS = ['SECRET-BUBBLE', 'SECRET-OBJECTIVE', 'SECRET-TASK', 'SECRET-GATE', 'SECRET-LINK'];

describe('LAN config (#39): off by default, one explicit address', () => {
  test('off unless the port is set', () => {
    expect(lanConfig({}, 4317)).toBeNull();
    expect(lanConfig({ ORCA_OFFICE_LAN_HOST: '192.168.1.20' }, 4317)).toBeNull();
  });
  test('port and one IPv4 address', () => {
    expect(lanConfig({ ORCA_OFFICE_LAN_PORT: '4318', ORCA_OFFICE_LAN_HOST: '192.168.1.20' }, 4317)).toEqual({ host: '192.168.1.20', port: 4318 });
    expect(() => lanConfig({ ORCA_OFFICE_LAN_PORT: '4318' }, 4317)).toThrow(/LAN_HOST/);
    expect(() => lanConfig({ ORCA_OFFICE_LAN_PORT: '4318', ORCA_OFFICE_LAN_HOST: '0.0.0.0' }, 4317)).toThrow(/0\.0\.0\.0/);
    expect(() => lanConfig({ ORCA_OFFICE_LAN_PORT: '4318', ORCA_OFFICE_LAN_HOST: 'tv.local' }, 4317)).toThrow();
    expect(() => lanConfig({ ORCA_OFFICE_LAN_PORT: '4318', ORCA_OFFICE_LAN_HOST: '192.168.1.300' }, 4317)).toThrow();
    expect(() => lanConfig({ ORCA_OFFICE_LAN_PORT: '4317', ORCA_OFFICE_LAN_HOST: '192.168.1.20' }, 4317)).toThrow(/differ/);
    expect(() => lanConfig({ ORCA_OFFICE_LAN_PORT: 'x', ORCA_OFFICE_LAN_HOST: '192.168.1.20' }, 4317)).toThrow();
  });
});

describe('LAN requests', () => {
  const c = { host: '192.168.1.20', port: 4318 };
  test('Host must be the LAN address (DNS rebinding)', () => {
    expect(lanHostAllowed('192.168.1.20:4318', c)).toBe(true);
    expect(lanHostAllowed('evil.example:4318', c)).toBe(false);
    expect(lanHostAllowed('127.0.0.1:4318', c)).toBe(false);
    expect(lanHostAllowed(undefined, c)).toBe(false);
  });
  test('the only socket is /lan, from the TV page itself', () => {
    const h = (origin?: string, host = '192.168.1.20:4318') => ({ host, ...(origin ? { origin } : {}) });
    expect(lanUpgradeAllowed('/lan', h('http://192.168.1.20:4318'), c)).toBe(true);
    expect(lanUpgradeAllowed('/lan?x=1', h('http://192.168.1.20:4318'), c)).toBe(true);
    expect(lanUpgradeAllowed('/client', h('http://192.168.1.20:4318'), c)).toBe(false);
    expect(lanUpgradeAllowed('/plugin', h(), c)).toBe(false);
    expect(lanUpgradeAllowed('/lan', h(), c)).toBe(false);
    expect(lanUpgradeAllowed('/lan', h('https://evil.example'), c)).toBe(false);
    expect(lanUpgradeAllowed('/lan', h('http://192.168.1.20:4318', 'evil.example:4318'), c)).toBe(false);
  });
  test('only the TV page and its assets are served', () => {
    expect(lanStaticPath('/')).toBe('/tv.html');
    expect(lanStaticPath('/tv')).toBe('/tv.html');
    expect(lanStaticPath('/assets/tv-abc123.js')).toBe('/assets/tv-abc123.js');
    expect(lanStaticPath('/index.html')).toBeNull();
    expect(lanStaticPath('/live.html')).toBeNull();
    expect(lanStaticPath('/__orca-office/token')).toBeNull();
    expect(lanStaticPath('/health')).toBeNull();
    expect(lanStaticPath('/assets/../index.html')).toBeNull();
    expect(lanStaticPath('/assets/x.map')).toBeNull();
  });
});

describe('LAN socket: takes a ping and nothing else', () => {
  test('a ping gets a pong', () => {
    expect(lanReply('{"t":"ping","at":5}', 9)).toEqual({ reply: '{"t":"pong","at":5,"now":9}' });
  });
  test.each([
    '{"t":"term.input","workerId":"a","data":"rm -rf /"}',
    '{"t":"orca.create","reqId":"r","floor":"f","agent":"claude","prompt":"x"}',
    '{"t":"orca.bot.send","workerId":"w","reqId":"r","chatId":"new","text":"hi"}',
    '{"t":"worker.attach","workerId":"a"}',
    '{"t":"orca.chat.open","workerId":"a"}',
    '{"t":"floor.go","floor":"f"}',
    '{"t":"ping","at":5,"extra":1}',
    '{"t":"ping"}',
    'not json',
    'null',
    '[]',
  ])('closes on %s', (raw) => {
    expect(lanReply(raw, 9)).toEqual({ close: true });
  });
  test('closes on an oversized frame', () => {
    expect(lanReply(JSON.stringify({ t: 'ping', at: 1, pad: 'x'.repeat(LAN_LIMITS.frame) }), 9)).toEqual({ close: true });
  });
});

const ws = (id: string, project: string, path: string): OrcaWorkspace => ({ id, kind: 'worktree', name: id, project, projectId: `p-${project}`, path, branch: id, hostId: 'local', state: 'active', unread: false, lastActivityAt: 1 });
const agent = (paneKey: string, path: string, over: Partial<CliAgent> = {}): CliAgent => ({ paneKey, sessionId: `s-${paneKey}`, kind: 'terminal', agent: 'claude', state: 'working', worktreeId: `repo-${path.split('/')[2]}::${path}`, workspace: 'w', repo: null, hostId: 'local', bubble: null, updatedAt: 1, ...over });
const run: OrcaRun = {
  id: 'run_a',
  objective: 'SECRET-OBJECTIVE',
  coordinatorHandle: null,
  legacy: false,
  updatedAt: NOW - 1000,
  tasks: [{ id: 't1', status: 'dispatched', title: 'SECRET-TASK' }],
  gates: [{ id: 'g1', taskId: 't1', question: 'SECRET-GATE', options: ['SECRET-GATE yes'] }],
  workers: [
    { dispatchId: 'ctx_1', taskId: 't1', state: 'running', workspace: 'repo-web::/code/web/a', host: 'local' },
    { dispatchId: 'ctx_2', taskId: 't1', state: 'running', workspace: 'repo-api::/code/api/b', host: 'local' },
  ],
};

describe('lanView: floors, desks, figures, states and badges; no private text', () => {
  test('carries the building without bubbles, titles, objectives, tasks, gates or link titles', () => {
    const m = new LiveModel();
    m.applyWorkspaces([ws('a', 'web', '/code/web/a'), ws('b', 'api', '/code/api/b'), ws('c', 'web', '/code/web/c')]);
    m.applyAgents('local', [agent('p1', '/code/web/a', { bubble: 'SECRET-BUBBLE', state: 'blocked' }), agent('p2', '/code/api/b', { bubble: 'SECRET-BUBBLE' })], NOW);
    m.applyWorktrees([{ id: 'repo-web::/code/web/a', repoId: 'repo-web', path: '/code/web/a', hostId: 'local', name: 'a', branch: 'a', links: [{ provider: 'github', kind: 'pr', ref: '#1', title: 'SECRET-LINK' }], parentId: null, childIds: [] }]);
    m.applyRuns([run], NOW);
    m.applyBots([{ id: 'b1', name: 'ReleaseBot', agent: 'claude', paused: false, specialty: 'SECRET-TASK specialty' }]);
    const b = m.building();
    // The model does carry the private texts (the full office gets them as bubbles and boards)…
    expect(JSON.stringify(b)).toContain('SECRET-BUBBLE');
    expect(JSON.stringify(b)).toContain('SECRET-OBJECTIVE');
    const v = lanView(b, true, NOW);
    const out = JSON.stringify(v);
    // …the LAN view never does.
    for (const s of SECRETS) expect(out).not.toContain(s);
    expect(out).not.toContain('/code/');
    expect(v.t).toBe('lan.view');
    const web = v.floors.find((f) => f.name === 'web')!;
    expect(web.waiting).toBe(1);
    expect(web.desks.map((d) => d.name).sort()).toEqual(['a', 'c']);
    const fig = web.desks.find((d) => d.name === 'a')!.figures[0]!;
    expect(Object.keys(fig).sort()).toEqual(['color', 'name', 'provider', 'status']);
    expect(fig.status).toBe('needs_input');
    expect(web.desks.find((d) => d.name === 'c')!.figures).toEqual([]);
    const room = v.floors.find((f) => f.room === 'project')!;
    expect(room.name).toBe('Project room');
    expect(room.desks.every((d) => d.name === '')).toBe(true);
    expect(room.waiting).toBeGreaterThan(0);
    const staff = v.floors.find((f) => f.room === 'staff')!;
    expect(staff.name).toBe('Staff');
  });
});
