import { describe, expect, test } from 'vitest';
import { LiveModel } from './model.js';
import type { OrcaWorkspace } from './orca.js';
import { EPHEMERAL_FROM, PortsPoller, pageTitle, parsePorts, safeCommand, type PortRow } from './ports.js';

// Everything here is made up: fake repos, paths, ports and commands.

const row = (port: number, over: Record<string, unknown> = {}) => ({
  id: `x:${port}`,
  bindHost: '*',
  connectHost: '127.0.0.1',
  port,
  pid: 1000 + port,
  processName: 'node',
  protocol: 'http',
  kind: 'workspace',
  owner: { worktreeId: 'r::/code/demo-web/fix-login', repoId: 'r', displayName: 'fix-login', path: '/code/demo-web/fix-login', confidence: 'cwd' },
  ...over,
});
const json = (...ports: unknown[]) => ({ ok: true, result: { ports } });

describe('parsePorts', () => {
  test('keeps worktree servers, drops external listeners, agent sockets and the office itself', () => {
    const out = parsePorts(
      json(
        row(5173),
        row(5173, { bindHost: '::1' }),
        row(3000, { kind: 'external', owner: undefined }),
        row(EPHEMERAL_FROM + 10, { protocol: 'unknown' }),
        row(EPHEMERAL_FROM + 11, { protocol: 'unknown', advertisedUrl: 'http://localhost:61001/' }),
        row(4317),
        row(9000, { protocol: 'unknown' }),
      ),
      new Set([4317]),
    );
    expect(out.map((p) => p.port)).toEqual([5173, 9000, EPHEMERAL_FROM + 11]);
    expect(out[0]).toMatchObject({ http: true, path: '/code/demo-web/fix-login', worktree: 'fix-login', host: '127.0.0.1' });
    expect(out[2]!.url).toBe('http://localhost:61001/');
  });

  test('only local http urls pass, never with credentials', () => {
    const [a, b] = parsePorts(json(row(5173, { advertisedUrl: 'https://evil.example/' }), row(5174, { advertisedUrl: 'http://u:p@localhost:5174/' })));
    expect(a!.url).toBeNull();
    expect(b!.url).toBeNull();
  });

  test('garbage is no ports', () => {
    expect(parsePorts(null)).toEqual([]);
    expect(parsePorts({ result: { ports: [null, 1, { port: 'x' }] } })).toEqual([]);
  });
});

describe('safeCommand', () => {
  test('short program names and paths', () => {
    expect(safeCommand('/usr/local/bin/node /code/demo/node_modules/.bin/vite --port 5173')).toBe('node vite --port 5173');
  });

  test('drops secrets: flags with values, env assignments, tokens by their looks', () => {
    const s = safeCommand('API_KEY=abc node server.js --token=made-up --password hunter2 --auth-token x ghp_madeupmadeupmadeup Zx9kQ2mP7vL4nR8sT1wY6bC3');
    expect(s).toBe('API_KEY=… node server.js --token=… --password … --auth-token … … …');
    expect(s).not.toMatch(/hunter2|made-up|abc|ghp_/);
  });

  test('cut to a short line', () => {
    expect(safeCommand(`node ${'a '.repeat(100)}`).length).toBeLessThanOrEqual(80);
  });
});

test('pageTitle', () => {
  expect(pageTitle('<html><head><title>Demo &amp; Co</title>')).toBe('Demo & Co');
  expect(pageTitle('<p>no title</p>')).toBeNull();
});

describe('PortsPoller', () => {
  test('asks ps once per process and the page title once a minute, and says when something changed', async () => {
    let t = 0;
    const calls = { ps: 0, title: 0, changed: 0 };
    let rows: PortRow[] = [];
    const p = new PortsPoller({
      run: async (args) => (expect(args).toEqual(['ports', '--all', '--json']), json(row(5173))),
      command: async () => (calls.ps++, 'node vite --port 5173 --token=x'),
      title: async () => (calls.title++, 'Demo'),
      wanted: () => true,
      changed: (r) => ((rows = r), calls.changed++),
      error: () => {},
      now: () => t,
    });
    await p.read();
    t = 10_000;
    await p.read();
    t = 70_000;
    await p.read();
    expect(calls).toEqual({ ps: 1, title: 2, changed: 1 });
    expect(rows[0]).toMatchObject({ port: 5173, command: 'node vite --port 5173 --token=…', title: 'Demo', since: 0 });
  });
});

describe('PortsPoller.kick', () => {
  test('a snapshot reads at once when the last read is stale, not again while it is fresh', async () => {
    let t = 1_000_000;
    let reads = 0;
    let looking = false;
    const p = new PortsPoller({ run: async () => (reads++, json(row(5173))), command: async () => 'vite', title: async () => null, wanted: () => looking, changed: () => {}, error: () => {}, now: () => t });
    expect(p.fresh()).toBe(false);
    looking = true;
    p.kick();
    await new Promise((r) => setTimeout(r, 10));
    expect(reads).toBe(1);
    expect(p.fresh()).toBe(true);
    p.kick();
    await new Promise((r) => setTimeout(r, 10));
    expect(reads).toBe(1);
    t += 31_000;
    expect(p.fresh()).toBe(false);
    p.stop();
  });
});

describe('the model', () => {
  const ws = (id: string, over: Partial<OrcaWorkspace> = {}): OrcaWorkspace => ({ id, kind: 'worktree', name: id, project: 'demo-web', projectId: `p-${over.project ?? 'demo-web'}`, path: `/code/demo-web/${id}`, branch: `feat/${id}`, hostId: 'local', state: 'active', unread: false, lastActivityAt: 1, ...over });
  const port = (n: number, path: string): PortRow => ({ port: n, pid: n, host: '127.0.0.1', processName: 'node', http: true, url: null, path, worktree: path.split('/').pop()!, command: 'vite', title: 'Demo', since: 5 });

  test("puts each server on its worktree's floor and desk, and on the desk's sign", () => {
    const m = new LiveModel();
    m.applyWorkspaces([ws('fix-login'), ws('closed', { state: 'inactive' }), ws('api', { project: 'demo-api', path: '/code/demo-api/api' })]);
    m.applyPorts([port(5173, '/code/demo-web/fix-login'), port(5174, '/code/demo-web/closed'), port(8080, '/code/demo-api/api'), port(9999, '/nowhere')]);
    const b = m.building();
    const web = b.floors.find((f) => f.info.name === 'demo-web')!;
    expect(web.services.map((s) => [s.port, s.worktree, s.branch, !!s.deskId])).toEqual([
      [5173, 'fix-login', 'feat/fix-login', true],
      [5174, 'closed', 'feat/closed', false],
    ]);
    expect(web.services[0]!.url).toBe('http://localhost:5173');
    expect(web.plan.labels[web.services[0]!.deskId!]!.pins).toBe('🖥 :5173');
    expect(b.floors.find((f) => f.info.name === 'demo-api')!.services.map((s) => s.port)).toEqual([8080]);
  });
});
