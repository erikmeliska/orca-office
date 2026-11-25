import { beforeEach, expect, test } from 'vitest';
import type { ServerMsg } from '@orca-office/shared/office/protocol';
import { pageLimits } from '../rate.js';
import { Extras } from './extras.js';
import { LiveModel } from './model.js';
import type { OrcaWorkspace } from './orca.js';

// Made-up Orca only: fake ids, paths and texts.
const AID = '497bafa9-5a97-4f85-9e48-2b211b8f31fa';
const ws = (id: string): OrcaWorkspace => ({ id, kind: 'worktree', name: id, project: 'demo', projectId: 'proj-demo', path: `/code/demo/${id}`, branch: id, hostId: 'local', state: 'active', unread: false, lastActivityAt: 1 });

let cliCalls: string[][];
let calls: { method: string; params: unknown }[];
let answers: Record<string, unknown>;
let sent: ServerMsg[];
let extras: Extras;
let page: { send: (m: ServerMsg[]) => void; limits: ReturnType<typeof pageLimits> };

beforeEach(() => {
  cliCalls = [];
  calls = [];
  sent = [];
  answers = {
    search: { result: { hits: [{ agent: 'claude', title: `Made-up session ${'x'.repeat(200)}`, cwd: '/code/demo/a', branch: 'refs/heads/a', updatedAt: '2026-11-25T10:00:00Z', evidence: { snippet: 'made-up webhook words', role: 'user' }, source: { filePath: '/secret/path.jsonl' }, resumeCommand: 'claude --resume x' }, { agent: 'codex', title: 'Elsewhere', cwd: '/nowhere', evidence: { snippet: 'y' } }] } },
    'automations list': { result: { automations: [{ id: AID, name: 'Made-up digest', prompt: 'PRIVATE PROMPT', enabled: true, rrule: 'FREQ=DAILY;BYHOUR=8', nextRunAt: 2000, bot: { botId: 'b' } }, { id: 'not-a-uuid', name: 'x' }] } },
    'automations runs': { result: { runs: [{ automationId: AID, status: 'completed', startedAt: 100 }, { automationId: AID, status: 'skipped_unavailable', startedAt: 50, errorCode: 'botPaused', error: 'PRIVATE ERROR TEXT' }] } },
    'workspace cleanup': { result: { evaluatedAt: 5, rows: [{ displayName: 'old-spike', repoName: 'demo', branch: 'refs/heads/old-spike', path: '/secret', evaluation: { action: 'remove', cause: 'merged' } }, { displayName: 'main', evaluation: { action: 'keep', cause: 'not-removable' } }, { displayName: 'x', evaluation: { action: 'keep', cause: 'rules-off' } }] } },
  };
  const model = new LiveModel();
  model.applyWorkspaces([ws('a')]);
  model.building();
  const cli = async (args: string[]) => {
    cliCalls.push(args);
    return answers[`${args[0]} ${args[1]}`] ?? answers[args[0]!] ?? {};
  };
  extras = new Extras(model, { cli, cliLong: cli, call: async (method, params) => (calls.push({ method, params }), { ok: true, value: {} }) });
  page = { send: (m) => sent.push(...m), limits: pageLimits() };
});

test('search (B8): 3+ characters, the query as one argument, bubbles only, a hit opens by index', async () => {
  await extras.handle(page, { t: 'orca.search', reqId: 'r1', query: 'we' });
  expect(cliCalls).toEqual([]);
  await extras.handle(page, { t: 'orca.search', reqId: 'r2', query: '--help me' });
  expect(cliCalls[0]).toEqual(['search', '--query=--help me', '--scope', 'conversation', '--limit', '12', '--json']);
  const m = sent.at(-1) as Extract<ServerMsg, { t: 'orca.search' }>;
  expect(m.hits[0]).toMatchObject({ index: 0, agent: 'claude', snippet: 'made-up webhook words', branch: 'a', worktree: 'a', canOpen: true });
  expect(m.hits[0]!.title.length).toBeLessThanOrEqual(60);
  expect(m.hits[1]).toMatchObject({ canOpen: false });
  expect(JSON.stringify(m)).not.toMatch(/secret|resume|cwd/);
  await extras.handle(page, { t: 'orca.search.open', index: 0 });
  expect(calls).toEqual([{ method: 'workspace.open', params: { workspaceId: 'a' } }]);
  await extras.handle(page, { t: 'orca.search.open', index: 1 });
  expect(sent.at(-1)).toMatchObject({ ok: false, error: 'unknown_workspace' });
});

test('automations (B9): no prompt, the last run; run only a listed one, confirmed', async () => {
  await extras.handle(page, { t: 'orca.automations.run', id: AID, confirm: true });
  expect(sent.at(-1)).toMatchObject({ ok: false, error: 'unknown_automation' });
  await extras.handle(page, { t: 'orca.automations' });
  const m = sent.at(-1) as Extract<ServerMsg, { t: 'orca.automations' }>;
  expect(m.items).toEqual([{ id: AID, name: 'Made-up digest', enabled: true, schedule: 'FREQ=DAILY;BYHOUR=8', nextRunAt: 2000, bot: true, last: { status: 'completed', at: 100 } }]);
  expect(JSON.stringify(m)).not.toContain('PRIVATE');
  await extras.handle(page, { t: 'orca.automations.run', id: AID } as never);
  expect(cliCalls.some((c) => c[1] === 'run')).toBe(false);
  await extras.handle(page, { t: 'orca.automations.run', id: AID, confirm: true });
  expect(cliCalls.at(-1)).toEqual(['automations', 'run', AID, '--json']);
});

test('cleanup (B11): the preview says what would go and why; running needs the same count, confirmed', async () => {
  await extras.handle(page, { t: 'orca.cleanup.run', confirm: 'remove', expect: 1 });
  expect(sent.at(-1)).toMatchObject({ ok: false, error: 'changed' });
  await extras.handle(page, { t: 'orca.cleanup.preview' });
  expect(sent.at(-1)).toEqual({ t: 'orca.cleanup', evaluatedAt: 5, remove: [{ name: 'old-spike', repo: 'demo', branch: 'old-spike', action: 'remove', cause: 'merged' }], keep: { 'not-removable': 1, 'rules-off': 1 } });
  await extras.handle(page, { t: 'orca.cleanup.run', confirm: 'yes', expect: 1 } as never);
  await extras.handle(page, { t: 'orca.cleanup.run', confirm: 'remove', expect: 2 });
  expect(cliCalls.some((c) => c[2] === 'run')).toBe(false);
  // Something changed since the page looked: refused, and the new preview sent.
  (answers['workspace cleanup'] as { result: { rows: unknown[] } }).result.rows.push({ displayName: 'other', evaluation: { action: 'remove', cause: 'merged' } });
  await extras.handle(page, { t: 'orca.cleanup.run', confirm: 'remove', expect: 1 });
  expect(sent.at(-1)).toMatchObject({ ok: false, error: 'changed' });
  expect(cliCalls.some((c) => c[2] === 'run')).toBe(false);
  await extras.handle(page, { t: 'orca.cleanup.run', confirm: 'remove', expect: 2 });
  expect(cliCalls.at(-1)).toEqual(['workspace', 'cleanup', 'run', '--json']);
  expect(sent.at(-1)).toMatchObject({ action: 'cleanup', ok: true });
});
