import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ApiChanged, ApiSnapshot } from '@orca-office/shared/office/api';
import { LiveModel } from '../live/model.js';
import { parseAgentList, parseBots, parseStatusEvent, parseWorkspaces } from '../live/orca.js';
import { parseGates, parseRunShow, parseTasks, parseWorkers } from '../live/runs.js';
import { parseWorktreeList } from '../live/worktrees.js';
import { OfficeApi, event, loadOrCreateApiToken } from './server.js';
import { PrivateTexts } from './private-texts.js';
import { SnapshotClock, fingerprint, snapshotBody, type SnapshotBody } from './snapshot.js';

// Everything here is made up: fake repos, paths, ids and messages.

const TOKEN = 'ab'.repeat(32);
const LONG_QUESTION = `Should I drop the old sessions table now? ${'It still has rows from the import. '.repeat(3)}Yes or no?`;

/** A made-up Orca as the CLI and the plugin would show it, through the same parsers the bridge uses. */
function fakeOffice(now = 1_000_000) {
  const m = new LiveModel();
  const texts = new PrivateTexts();
  m.applyWorkspaces(
    parseWorkspaces({
      workspaces: [
        { id: 'ws-login', kind: 'worktree', name: 'fix-login', project: 'demo-web', projectId: 'repo:demo-web', path: '/code/demo-web/fix-login', branch: 'refs/heads/fix-login', hostId: 'local', status: { state: 'active', unread: true, lastActivityAt: now - 5_000 } },
        { id: 'ws-dark', kind: 'worktree', name: 'dark-mode', project: 'demo-web', projectId: 'repo:demo-web', path: '/code/demo-web/dark-mode', branch: 'dark-mode', hostId: 'local', status: { state: 'active', unread: false, lastActivityAt: now - 9_000 } },
      ],
    }),
  );
  const worktrees = {
    worktrees: [
      { id: 'repo-web::/code/demo-web', repoId: 'repo-web', projectId: 'repo:demo-web', isMainWorktree: true, path: '/code/demo-web', hostId: 'local', displayName: 'main', branch: 'main' },
      { id: 'repo-web::/code/demo-web/fix-login', repoId: 'repo-web', projectId: 'repo:demo-web', path: '/code/demo-web/fix-login', hostId: 'local', displayName: 'fix-login', branch: 'fix-login', workspaceStatus: 'in-review', comment: 'Waiting on the design review', linkedItems: [{ provider: 'github', type: 'pr', number: 128, url: 'https://github.com/example/demo-web/pull/128', title: 'Redirect to the login page when the session expires' }] },
      { id: 'repo-web::/code/demo-web/dark-mode', repoId: 'repo-web', projectId: 'repo:demo-web', path: '/code/demo-web/dark-mode', hostId: 'local', displayName: 'dark-mode', branch: 'dark-mode' },
    ],
  };
  texts.worktreeList(worktrees);
  m.applyWorktrees(parseWorktreeList(worktrees));
  const agents = {
    agents: [
      { paneKey: 'pane-login', orcaSessionId: 'orca-s1', kind: 'terminal', agent: 'claude', state: 'waiting', worktreeId: 'repo-web::/code/demo-web/fix-login', workspace: 'fix-login', repo: 'demo-web', hostId: 'local', title: 'Fix the expired-session redirect', lastAssistantMessage: LONG_QUESTION, updatedAt: now - 60_000 },
      { paneKey: 'pane-dark', orcaSessionId: 'orca-s2', kind: 'chat', agent: 'codex', state: 'working', worktreeId: 'repo-web::/code/demo-web/dark-mode', workspace: 'dark-mode', repo: 'demo-web', hostId: 'local', title: 'Dark mode tokens', lastAssistantMessage: 'Switching the palette to tokens.', updatedAt: now - 30 * 60_000 },
    ],
  };
  texts.agentList('local', agents);
  m.applyAgents('local', parseAgentList(agents).agents, now - 60_000);
  m.applyStatus(parseStatusEvent({ paneKey: 'pane-login', workspaceListId: 'ws-login', terminalId: 'term-1', state: 'waiting', sessionId: 'claude-session-1' }, now - 60_000)!);
  m.applyBots(parseBots({ bots: [{ id: 'bot-1', name: 'ReleaseBot', agent: 'claude', paused: false, specialty: 'Releases' }] }));
  const show = { run: { id: 'run-1', objective: 'Ship the login fix across web and api, with a migration plan for the sessions table', updated_at: new Date(now).toISOString() } };
  const tasks = { tasks: [{ id: 'task-1', status: 'dispatched', title: 'Fix the redirect in demo-web after the session expires on any page' }] };
  const gates = { gates: [{ id: 'gate-1', taskId: 'task-1', status: 'pending', question: 'Drop the old sessions table in the same release, or keep it one more week?', options: '["Drop it now","Keep it a week"]' }] };
  const workers = { workers: [{ dispatchId: 'd-1', taskId: 'task-1', state: 'running', workspace: 'repo-web::/code/demo-web/fix-login', host: 'local' }] };
  texts.runShow(show);
  texts.taskList('run-1', tasks);
  texts.gateList('run-1', gates);
  m.applyRuns([{ ...parseRunShow(show)!, tasks: parseTasks(tasks), gates: parseGates(gates), workers: parseWorkers(workers) }], now);
  return { m, texts, now };
}

function body(now = 1_000_000): SnapshotBody {
  const { m, texts } = fakeOffice(now);
  return snapshotBody({ state: m.apiState(), texts, connected: true, lastSnapshotAt: now - 1_000, limits: { providers: [{ id: 'claude', name: 'Claude', status: 'ok', plan: 'max', windows: [{ label: '5h', pct: 42, resetsAt: now + 3_600_000 }], at: now }], at: now }, now });
}

describe('snapshot', () => {
  test('has floors, worktrees, agents, bots, runs, usage and rooms in the v1 shape', () => {
    const b = body();
    const snap = new SnapshotClock().stamp(b, 1_000_000);
    expect(snap).toMatchObject({ version: 1, at: 1_000_000, rev: 1, orca: { connected: true, lastSnapshotAt: 999_000 } });
    expect(snap.fingerprint).toMatch(/^[\w-]{22}$/);

    expect(snap.floors).toEqual([{ id: expect.stringMatching(/^f-/), projectId: 'repo:demo-web', name: 'demo-web', dir: '/code/demo-web', needsYou: 1, working: 1, stuck: 1, done: 0 }]);
    const floorId = snap.floors[0]!.id;

    const login = snap.worktrees.find((w) => w.name === 'fix-login')!;
    expect(login).toEqual({
      id: 'ws-login',
      orcaWorktreeId: 'repo-web::/code/demo-web/fix-login',
      floorId,
      kind: 'worktree',
      name: 'fix-login',
      branch: 'fix-login',
      path: '/code/demo-web/fix-login',
      hostId: 'local',
      open: true,
      workspaceStatus: 'in-review',
      unread: true,
      lastActivityAt: 995_000,
      comment: 'Waiting on the design review',
      links: [{ provider: 'github', kind: 'pr', ref: '#128', url: 'https://github.com/example/demo-web/pull/128', title: 'Redirect to the login page when the session expires' }],
      servers: [],
      isMain: false,
      parentId: null,
    });

    const [asking, working] = snap.agents;
    expect(asking).toMatchObject({
      id: expect.stringMatching(/^a-/),
      worktreeId: 'ws-login',
      floorId,
      agent: 'claude',
      surface: 'terminal',
      state: 'waiting',
      needsYou: true,
      asks: 'question',
      stuck: false,
      title: 'Fix the expired-session redirect',
      question: LONG_QUESTION,
      orcaSessionId: 'orca-s1',
      sessionId: 'claude-session-1',
      paneKey: 'pane-login',
      terminalId: 'term-1',
      hostId: 'local',
    });
    // The full question, and the bubble the page gets: one line, 120 characters at most.
    expect(asking!.question!.length).toBeGreaterThan(120);
    expect(asking!.bubble!.length).toBeLessThanOrEqual(120);
    // Working agents have no question; quiet for 30 min, this one looks stuck.
    expect(working).toMatchObject({ surface: 'chat', state: 'working', needsYou: false, asks: null, question: null, stuck: true, stuckWhy: 'quiet', title: 'Dark mode tokens' });

    expect(snap.bots).toEqual([{ id: 'bot-1', name: 'ReleaseBot', agent: 'claude', specialty: 'Releases', state: 'idle', chats: [] }]);
    expect(snap.runs).toEqual([
      {
        id: 'run-1',
        objective: 'Ship the login fix across web and api, with a migration plan for the sessions table',
        live: true,
        updatedAt: 1_000_000,
        tasks: [{ id: 'task-1', status: 'dispatched', title: 'Fix the redirect in demo-web after the session expires on any page' }],
        gates: [{ id: 'gate-1', taskId: 'task-1', question: 'Drop the old sessions table in the same release, or keep it one more week?', options: ['Drop it now', 'Keep it a week'] }],
        workers: [{ dispatchId: 'd-1', taskId: 'task-1', state: 'running', worktree: 'repo-web::/code/demo-web/fix-login', hostId: 'local' }],
        coordinator: null,
      },
    ]);
    expect(snap.rooms).toEqual([{ id: expect.stringMatching(/^p-/), source: 'run', runId: 'run-1', name: 'Ship the login fix across web and api, with a migration plan for the sessions table', coordinator: null, members: ['repo-web::/code/demo-web/fix-login'] }]);
    expect(snap.usage).toEqual({ at: 1_000_000, providers: [{ id: 'claude', name: 'Claude', status: 'ok', plan: 'max', windows: [{ label: '5h', pct: 42, resetsAt: 4_600_000 }], at: 1_000_000 }] });
  });

  test('the office page still gets only bubbles: the full texts are the API’s alone', () => {
    const { m } = fakeOffice();
    const page = JSON.stringify(m.building());
    expect(page).not.toContain(LONG_QUESTION);
    expect(page).not.toContain('Fix the expired-session redirect');
    expect(page).not.toContain('Waiting on the design review');
    expect(page).not.toContain('with a migration plan for the sessions table');
  });

  test('rev moves only when the content does; the plugin’s snapshot time alone is no change', () => {
    const clock = new SnapshotClock();
    const b = body();
    expect(clock.stamp(b, 1).rev).toBe(1);
    expect(clock.stamp({ ...b, orca: { ...b.orca, lastSnapshotAt: 5 } }, 2).rev).toBe(1);
    expect(clock.stamp({ ...b, orca: { ...b.orca, connected: false } }, 3).rev).toBe(2);
    expect(fingerprint(b)).toBe(fingerprint(body()));
  });

  test('private texts never print', () => {
    const { texts } = fakeOffice();
    expect(JSON.stringify({ texts })).toBe('{"texts":"[private texts]"}');
  });

  test('tap() hands the polled CLI answers to the store and returns them unchanged', async () => {
    const texts = new PrivateTexts();
    const answer = { result: { agents: [{ paneKey: 'p-env', title: 'On the build box', lastAssistantMessage: 'Line one\nline two' }] } };
    const run = texts.tap(async () => answer);
    expect(await run(['agent', 'list', '--json', '--environment', 'buildbox'])).toBe(answer);
    expect(texts.agent('buildbox', 'p-env')).toEqual({ title: 'On the build box', lastMessage: 'Line one\nline two' });
    expect(texts.agent('local', 'p-env').lastMessage).toBeNull();
  });
});

// ---- over HTTP ---------------------------------------------------------------------------------

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

let server: Server;
let api: OfficeApi;
let port: number;
let current: SnapshotBody;
const clock = new SnapshotClock();

beforeEach(async () => {
  current = body();
  server = createServer((req, res) => (OfficeApi.handles(req.url) ? api.handle(req, res) : res.writeHead(404).end()));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  api = new OfficeApi({ port, token: () => TOKEN, connected: () => true, snapshot: () => clock.stamp(current, Date.now()) });
});

afterEach(async () => {
  api.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

function get(path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

const auth = () => ({ authorization: `Bearer ${TOKEN}` });

describe('authentication', () => {
  test('no token: 401', async () => {
    const r = await get('/api/v1/snapshot');
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body)).toEqual({ error: 'unauthorized' });
    expect(r.body).not.toContain('fix-login');
  });

  test('a wrong token: 401', async () => {
    expect((await get('/api/v1/snapshot', { authorization: `Bearer ${'cd'.repeat(32)}` })).status).toBe(401);
    expect((await get('/api/v1/events', { authorization: 'Basic abc' })).status).toBe(401);
  });

  test('any Origin: 403, even with the token (the API is for processes, not pages)', async () => {
    const r = await get('/api/v1/snapshot', { ...auth(), origin: `http://127.0.0.1:${port}` });
    expect(r.status).toBe(403);
    expect((await get('/api/v1/health', { origin: 'https://example.com' })).status).toBe(403);
  });

  test('a Host that is not the bridge’s loopback address: 421', async () => {
    expect((await get('/api/v1/snapshot', { ...auth(), host: `evil.example:${port}` })).status).toBe(421);
    expect((await get('/api/v1/health', { host: '192.168.1.20' })).status).toBe(421);
  });

  test('the token: 200 and the snapshot', async () => {
    const r = await get('/api/v1/snapshot', { ...auth(), host: `localhost:${port}` });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const snap = JSON.parse(r.body) as ApiSnapshot;
    expect(snap.version).toBe(1);
    expect(snap.agents.find((a) => a.needsYou)?.question).toBe(LONG_QUESTION);
  });

  test('health needs no token and says nothing private', async () => {
    const r = await get('/api/v1/health');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, version: 1, orca: { connected: true } });
  });

  test('unknown paths and other methods', async () => {
    expect((await get('/api/v1/nope', auth())).status).toBe(404);
    const post = await new Promise<number>((resolve) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/v1/snapshot', method: 'POST', headers: { host: `127.0.0.1:${port}`, ...auth() } }, (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(post).toBe(405);
  });

  test('failed tokens are rate-limited: 429', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await get('/api/v1/snapshot')).status);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  test('the consumer token: its own file, 0600 in a 0700 folder, the same on the next start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-office-api-'));
    try {
      const path = join(dir, 'home', 'api-token');
      const t = loadOrCreateApiToken(path);
      expect(t).toMatch(/^[0-9a-f]{64}$/);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'home')).mode & 0o777).toBe(0o700);
      expect(loadOrCreateApiToken(path)).toBe(t);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('events (SSE)', () => {
  test('a snapshot at once, then changed when the content changes, nothing when it doesn’t', async () => {
    const events: { name: string; id?: string; data: unknown }[] = [];
    let buffer = '';
    let wake: () => void = () => {};
    const req = request({ host: '127.0.0.1', port, path: '/api/v1/events', headers: { host: `127.0.0.1:${port}`, ...auth() } }, (res) => {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buffer += c;
        let i: number;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const id = /^id: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name && data) events.push({ name, ...(id ? { id } : {}), data: JSON.parse(data) });
          wake();
        }
      });
    });
    req.end();
    const until = (n: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out with ${events.length} events`)), 3_000);
        const check = () => {
          if (events.length >= n) {
            clearTimeout(timer);
            resolve();
          }
        };
        wake = check;
        check();
      });

    await until(1);
    expect(events[0]!.name).toBe('snapshot');
    const first = events[0]!.data as ApiSnapshot;
    expect(first.version).toBe(1);
    expect(api.listeners).toBe(1);

    // Nothing changed: no event.
    api.changed();
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(1);

    current = { ...current, floors: current.floors.map((f) => ({ ...f, needsYou: f.needsYou + 1 })) };
    api.changed();
    await until(2);
    expect(events[1]!.name).toBe('changed');
    const ch = events[1]!.data as ApiChanged;
    expect(ch.rev).toBe(first.rev + 1);
    expect(ch.fingerprint).not.toBe(first.fingerprint);
    expect(events[1]!.id).toBe(String(ch.rev));
    // The changed event carries no content, private or otherwise.
    expect(JSON.stringify(ch)).not.toContain('fix-login');
    req.destroy();
  });

  test('event() writes one JSON line per event', () => {
    expect(event('changed', { rev: 2, text: 'a\nb' }, 2)).toBe('event: changed\nid: 2\ndata: {"rev":2,"text":"a\\nb"}\n\n');
  });
});
