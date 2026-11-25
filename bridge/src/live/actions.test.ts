import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@orca-office/shared/office/protocol';
import type { CallResult } from '../plugin-link.js';
import { pageLimits } from '../rate.js';
import { Actions, CHAT_EVERY_MS, CREATE_WAIT_MS, chunks } from './actions.js';
import { LiveModel, floorId } from './model.js';
import { parseConversation, type CliAgent, type OrcaWorkspace } from './orca.js';
import { TerminalWatch } from './terminals.js';

// Made-up Orca only: fake repos, ids and text.

const ws = (id: string, over: Partial<OrcaWorkspace> = {}): OrcaWorkspace => ({ id, kind: 'worktree', name: id, project: 'demo', projectId: `proj-${over.project ?? 'demo'}`, path: `/code/demo/${id}`, branch: id, hostId: 'local', state: 'active', unread: false, lastActivityAt: 1, ...over });
const agent = (paneKey: string, wt: string, over: Partial<CliAgent> = {}): CliAgent => ({ paneKey, sessionId: `s-${paneKey}`, kind: 'terminal', agent: 'claude', state: 'working', worktreeId: `r::/code/demo/${wt}`, workspace: wt, repo: 'demo', hostId: 'local', bubble: null, updatedAt: 1, ...over });
const FLOOR = floorId('demo', 'p:proj-demo');
const T = 'term_aaa';

let now = 1_000;
let calls: { method: string; params: unknown }[];
let cliCalls: string[][];
let sends: { terminalId: string; text: string; enter: boolean }[];
/** How long a fake CLI send takes (a real one ~0.2 s). */
let sendMs = 0;
let answers: Record<string, CallResult>;
let conversation: unknown;
let model: LiveModel;
let actions: Actions;
let sent: ServerMsg[];
let page: { floor: () => string | undefined; send: (m: ServerMsg[]) => void; limits: ReturnType<typeof pageLimits> };
let terminals: TerminalWatch;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  cliCalls = [];
  sends = [];
  sendMs = 0;
  answers = {};
  conversation = { ok: true, result: { kind: 'chat', state: 'working', limited: false, entries: [{ kind: 'message', role: 'user', text: 'Made-up question' }, { kind: 'tool', name: 'Bash', state: 'completed' }, { kind: 'message', role: 'assistant', text: 'Made-up answer' }] } };
  sent = [];
  model = new LiveModel();
  model.applyWorkspaces([ws('a'), ws('b'), ws('c')]);
  model.applyAgents('local', [agent('pane-1', 'a'), agent('pane-chat', 'b', { kind: 'chat' })], now);
  model.applyTerminals([{ handle: T, paneKey: 'pane-1' }]);
  model.building();
  const call = async (method: string, params: unknown) => {
    calls.push({ method, params });
    return answers[method] ?? { ok: true, value: method === 'terminal.read' ? { lines: ['$ hello'], truncated: false } : {} };
  };
  terminals = new TerminalWatch((terminalId, maxLines) => call('terminal.read', { terminalId, maxLines }), 250);
  actions = new Actions(model, { call, send: async (terminalId, text, enter) => {
      sends.push({ terminalId, text, enter });
      if (sendMs) await new Promise((r) => setTimeout(r, sendMs));
      return true;
    }, cli: async (args) => (cliCalls.push(args), args[0] === 'agent' ? conversation : args[1] === 'show' ? { result: { worktree: { comment: 'note', isUnread: true } } } : { ok: true }), resync: () => {}, now: () => now }, terminals);
  page = { floor: () => FLOOR, send: (m) => sent.push(...m), limits: pageLimits(now) };
});
afterEach(() => vi.useRealTimers());

const idOf = (pane: string) => model.building().floors[0]!.workers.find((w) => model.target(w.id)?.paneKey === pane)!.id;
const seatOf = (pane: string) => model.building().floors[0]!.workers.find((w) => model.target(w.id)?.paneKey === pane)!.deskId;
const flush = () => vi.advanceTimersByTimeAsync(0);

test('figures say what the office can do with them', () => {
  const workers = model.building().floors[0]!.workers;
  expect(workers.map((w) => w.orca).sort((x, y) => Number(x!.terminal) - Number(y!.terminal))).toEqual([{ terminal: false, remote: false, worktree: 'b', branch: 'b', quietSince: 1 }, { terminal: true, remote: false, worktree: 'a', branch: 'a', quietSince: 1 }]);
  expect(model.building().floors[0]!.info.orcaCreate).toBe(true);
});

test('attach polls the open terminal and sends it while it changes, only while open', async () => {
  const id = idOf('pane-1');
  await actions.handle(page, { t: 'worker.attach', workerId: id });
  await flush();
  expect(sent).toContainEqual({ t: 'term.snapshot', workerId: id, data: '$ hello', cols: 0, rows: 0 });
  answers['terminal.read'] = { ok: true, value: { lines: ['$ hello', 'world'], truncated: false } };
  await vi.advanceTimersByTimeAsync(250);
  expect(sent.at(-1)).toEqual({ t: 'term.snapshot', workerId: id, data: '$ hello\r\nworld', cols: 0, rows: 0 });
  const reads = calls.filter((c) => c.method === 'terminal.read').length;
  expect(calls.find((c) => c.method === 'terminal.read')!.params).toEqual({ terminalId: T, maxLines: 500 });
  // Unchanged text is not sent again.
  const before = sent.length;
  await vi.advanceTimersByTimeAsync(250);
  expect(sent.length).toBe(before);
  await actions.handle(page, { t: 'worker.detach', workerId: id });
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls.filter((c) => c.method === 'terminal.read').length).toBe(reads + 1);
  expect(terminals.size).toBe(0);
});

test('a chat agent has no terminal to attach', async () => {
  await actions.handle(page, { t: 'worker.attach', workerId: idOf('pane-chat') });
  expect(sent).toEqual([{ t: 'orca.result', action: 'terminal', ok: false, error: 'no_terminal', workerId: idOf('pane-chat') }]);
});

test('typing goes raw, in order, only into the open terminal, a burst merged into few sends', async () => {
  const id = idOf('pane-1');
  await actions.handle(page, { t: 'term.input', workerId: id, data: 'x' });
  expect(sent.at(-1)).toMatchObject({ t: 'orca.result', action: 'type', ok: false, error: 'not_open' });
  await actions.handle(page, { t: 'worker.attach', workerId: id });
  sendMs = 200;
  const keys = ['\x1b', '\x03', '\t', '\x1b[Z', '\x1b[A', '\x7f', 'hi', '\r'];
  for (const data of keys) await actions.handle(page, { t: 'term.input', workerId: id, data });
  await vi.advanceTimersByTimeAsync(1000);
  expect(sends.map((s) => s.text).join('')).toBe(keys.join(''));
  expect(sends.length).toBeLessThan(keys.length);
  expect(sends.every((s) => s.terminalId === T && !s.enter)).toBe(true);
  // Typing never goes through the plugin (Orca refuses it outside the active workspace).
  expect(calls.some((c) => c.method === 'terminal.sendText')).toBe(false);
});

test('a long paste goes in 4096-char pieces, NULs dropped', async () => {
  const id = idOf('pane-1');
  await actions.handle(page, { t: 'worker.attach', workerId: id });
  await actions.handle(page, { t: 'term.input', workerId: id, data: 'y'.repeat(9000) + '\0' });
  await flush();
  expect(sends.map((s) => s.text.length)).toEqual([4096, 4096, 808]);
  expect(chunks('a😀b', 2)).toEqual(['a', '😀', 'b']);
});

test('typing is rate-limited', async () => {
  const id = idOf('pane-1');
  await actions.handle(page, { t: 'worker.attach', workerId: id });
  for (let i = 0; i < 250; i++) await actions.handle(page, { t: 'term.input', workerId: id, data: 'k' });
  await flush();
  expect(sends.map((s) => s.text).join('').length).toBe(200);
  expect(sent.filter((m) => m.t === 'orca.result' && m.error === 'rate_limited').length).toBe(1);
});

test('a prompt from the desk is typed and entered', async () => {
  await actions.handle(page, { t: 'worker.prompt', workerId: idOf('pane-1'), prompt: 'go on' });
  await flush();
  expect(sends).toEqual([{ terminalId: T, text: 'go on', enter: true }]);
});

test('open in Orca shows the workspace and focuses the terminal; a chat only its workspace', async () => {
  await actions.handle(page, { t: 'orca.open', workerId: idOf('pane-1') });
  expect(calls.map((c) => c.method)).toEqual(['workspace.open', 'terminal.focus']);
  expect(calls[0]!.params).toEqual({ workspaceId: 'a' });
  expect(calls[1]!.params).toEqual({ terminalId: T });
  calls = [];
  await actions.handle(page, { t: 'orca.open', workerId: idOf('pane-chat') });
  expect(calls).toEqual([{ method: 'workspace.open', params: { workspaceId: 'b' } }]);
  expect(sent.at(-1)).toMatchObject({ t: 'orca.result', action: 'open', ok: true });
});

test('mark read and the comment go through orca worktree set, by the desk', async () => {
  const desk = seatOf('pane-1');
  await actions.handle(page, { t: 'orca.read', deskId: desk });
  await actions.handle(page, { t: 'orca.comment', deskId: desk, comment: '-rf waiting on review' });
  await actions.handle(page, { t: 'orca.desk', deskId: desk });
  expect(cliCalls).toEqual([
    ['worktree', 'set', '--worktree', 'a', '--read', '--json'],
    ['worktree', 'set', '--worktree', 'a', '--comment=-rf waiting on review', '--json'],
    ['worktree', 'show', '--worktree', 'a', '--json'],
  ]);
  expect(sent).toContainEqual({ t: 'orca.desk', deskId: desk, comment: 'note', unread: true });
  await actions.handle(page, { t: 'orca.read', deskId: 'desk-99' });
  expect(sent.at(-1)).toMatchObject({ action: 'read', ok: false, error: 'unknown_workspace' });
  await actions.handle(page, { t: 'orca.comment', deskId: desk, comment: 'x'.repeat(2001) });
  expect(sent.at(-1)).toMatchObject({ action: 'comment', ok: false, error: 'invalid' });
});

test('a new task creates a workspace with the agent and is ready once its figure sits down', async () => {
  answers['workspace.create'] = { ok: true, value: { workspaceId: 'r::/code/demo/new-task' } };
  await actions.handle(page, { t: 'orca.create', reqId: 'r1', floor: FLOOR, agent: 'claude', prompt: 'Say hi', name: 'new-task' });
  expect(calls).toEqual([{ method: 'workspace.create', params: { projectId: 'proj-demo', agent: 'claude', prompt: 'Say hi', name: 'new-task' } }]);
  expect(sent).toEqual([
    { t: 'orca.create', reqId: 'r1', phase: 'creating' },
    { t: 'orca.create', reqId: 'r1', phase: 'created' },
  ]);
  actions.tick();
  expect(sent.length).toBe(2);
  model.applyWorkspaces([ws('a'), ws('b'), ws('c'), ws('new', { path: '/code/demo/new-task' })]);
  model.applyAgents('local', [agent('pane-1', 'a'), agent('pane-chat', 'b', { kind: 'chat' }), agent('pane-new', 'new-task')], now);
  model.building();
  actions.tick();
  expect(sent.at(-1)).toEqual({ t: 'orca.create', reqId: 'r1', phase: 'ready', floor: FLOOR, deskId: seatOf('pane-new') });
});

test('a new task is checked before it reaches Orca, and slow ones give up', async () => {
  const bad = [
    { agent: 'bash', error: 'unknown_agent' },
    { prompt: ' ', error: 'invalid_prompt' },
    { name: '../x', error: 'invalid_name' },
    { floor: 'f-nowhere', error: 'no_project' },
  ];
  for (const b of bad) await actions.handle(page, { t: 'orca.create', reqId: 'r', floor: FLOOR, agent: 'claude', prompt: 'p', ...b } as never);
  expect(calls).toEqual([]);
  expect(sent.map((m) => (m as { error?: string }).error)).toEqual(bad.map((b) => b.error));
  sent = [];
  answers['workspace.create'] = { ok: true, value: { workspaceId: 'r::/code/demo/slow' } };
  for (let i = 0; i < 4; i++) await actions.handle(page, { t: 'orca.create', reqId: `q${i}`, floor: FLOOR, agent: 'codex', prompt: 'p' });
  expect(calls.length).toBe(3);
  expect(sent.at(-1)).toEqual({ t: 'orca.create', reqId: 'q3', phase: 'failed', error: 'rate_limited' });
  now += CREATE_WAIT_MS + 1;
  actions.tick();
  expect(sent.filter((m) => m.t === 'orca.create' && m.phase === 'failed' && m.error === 'no_agent_yet').length).toBe(3);
});

test('a remote figure is shown but not acted on', async () => {
  model.applyAgents('runtime:env', [agent('pane-far', 'far', { hostId: 'runtime:env', repo: 'demo' })], now);
  model.building();
  const far = model.building().floors[0]!.workers.find((w) => w.orca?.remote)!;
  await actions.handle(page, { t: 'orca.open', workerId: far.id });
  await actions.handle(page, { t: 'worker.attach', workerId: far.id });
  expect(calls).toEqual([]);
  expect(sent.map((m) => (m as { error?: string }).error)).toEqual(['remote', 'remote']);
});

test('a chat panel reads the conversation by session id while open, sending only changes', async () => {
  const id = idOf('pane-chat');
  await actions.handle(page, { t: 'orca.chat.open', workerId: id });
  expect(cliCalls).toEqual([['agent', 'read', 's-pane-chat', '--json', '--limit', '50']]);
  expect(sent).toEqual([{ t: 'orca.chat', workerId: id, state: 'working', limited: false, entries: [{ role: 'user', text: 'Made-up question' }, { tool: 'Bash', state: 'completed' }, { role: 'assistant', text: 'Made-up answer' }] }]);
  await vi.advanceTimersByTimeAsync(CHAT_EVERY_MS);
  expect(cliCalls.length).toBe(2);
  expect(sent.length).toBe(1);
  conversation = { ok: true, result: { state: 'done', limited: true, entries: [] } };
  await vi.advanceTimersByTimeAsync(CHAT_EVERY_MS);
  expect(sent.at(-1)).toEqual({ t: 'orca.chat', workerId: id, state: 'done', limited: true, entries: [] });
  await actions.handle(page, { t: 'orca.chat.close', workerId: id });
  await vi.advanceTimersByTimeAsync(CHAT_EVERY_MS * 3);
  expect(cliCalls.length).toBe(3);
});

test('a chat panel is refused for remote agents and odd session ids, and stops with the page', async () => {
  model.applyAgents('local', [agent('pane-1', 'a'), agent('pane-chat', 'b', { kind: 'chat', sessionId: '--help' })], now);
  model.building();
  await actions.handle(page, { t: 'orca.chat.open', workerId: idOf('pane-chat') });
  expect(sent.at(-1)).toMatchObject({ action: 'chat', ok: false, error: 'no_session' });
  model.applyAgents('local', [agent('pane-1', 'a'), agent('pane-chat', 'b', { kind: 'chat' })], now);
  model.building();
  await actions.handle(page, { t: 'orca.chat.open', workerId: idOf('pane-chat') });
  actions.closed(page);
  const n = cliCalls.length;
  await vi.advanceTimersByTimeAsync(CHAT_EVERY_MS * 2);
  expect(cliCalls.length).toBe(n);
  expect(cliCalls.every((c) => !c.includes('--help'))).toBe(true);
});

test('a conversation keeps messages and tool names only, cut to size', () => {
  const c = parseConversation({ result: { state: 'done', entries: [{ kind: 'message', role: 'system', text: 'x' }, { kind: 'message', role: 'assistant', text: 'y'.repeat(25_000) }, { kind: 'tool', name: 'Read', state: 'completed', input: { path: '/secret' } }, { kind: 'other' }] } });
  expect(c?.entries).toEqual([{ role: 'assistant', text: 'y'.repeat(20_000), shortened: true }, { tool: 'Read', state: 'completed' }]);
  expect(parseConversation({ result: {} })).toBeNull();
});

// ---- M7 B1: answering a permission prompt from the banner -------------------------------------

const MENU = ['Do you want to proceed?', '❯ 1. Yes', "  2. Yes, and don't ask again for npm test in /x", '  3. No, and tell Claude what to do differently (esc)'];

function blocked() {
  model.applyAgents('local', [agent('pane-1', 'a', { state: 'blocked' }), agent('pane-chat', 'b', { kind: 'chat' })], now);
  model.building();
}

test('a blocked agent says it asks permission, and the waiting list says it can be answered here', () => {
  blocked();
  const b = model.building();
  const w = b.floors[0]!.workers.find((x) => x.id === idOf('pane-1'))!;
  expect(w.orca?.asks).toBe('permission');
  expect(b.waiting[0]).toMatchObject({ asks: 'permission', terminal: true });
  model.applyAgents('local', [agent('pane-1', 'a', { state: 'waiting' })], now);
  expect(model.building().waiting[0]).toMatchObject({ asks: 'question' });
});

test('Yes / Always / No read the screen and send only the key that picks it', async () => {
  blocked();
  answers['terminal.read'] = { ok: true, value: { lines: MENU, truncated: false } };
  const id = idOf('pane-1');
  await actions.handle(page, { t: 'orca.answer', workerId: id, choice: 'always', since: model.target(id)!.since });
  await flush();
  expect(calls.at(-1)).toEqual({ method: 'terminal.read', params: { terminalId: T, maxLines: 30 } });
  expect(sends).toEqual([{ terminalId: T, text: '2', enter: false }]);
  expect(sent).toContainEqual({ t: 'orca.result', action: 'answer', ok: true, workerId: id });
  await actions.handle(page, { t: 'orca.answer', workerId: id, choice: 'no', since: model.target(id)!.since });
  await flush();
  expect(sends.at(-1)).toEqual({ terminalId: T, text: '\x1b', enter: false });
});

test('nothing is typed without a menu on the screen, into a working agent, a chat or for a made-up choice', async () => {
  const id = idOf('pane-1');
  await actions.handle(page, { t: 'orca.answer', workerId: id, choice: 'yes', since: 1 });
  expect(sent.at(-1)).toMatchObject({ action: 'answer', ok: false, error: 'not_asking' });
  blocked();
  const since = model.target(id)!.since;
  await actions.handle(page, { t: 'orca.answer', workerId: id, choice: 'yes', since });
  expect(sent.at(-1)).toMatchObject({ action: 'answer', ok: false, error: 'no_prompt' });
  // A prompt that came up after the one the page showed is not answered.
  answers['terminal.read'] = { ok: true, value: { lines: MENU, truncated: false } };
  await actions.handle(page, { t: 'orca.answer', workerId: id, choice: 'yes', since: since - 5 });
  expect(sent.at(-1)).toMatchObject({ action: 'answer', ok: false, error: 'prompt_changed' });
  await actions.handle(page, { t: 'orca.answer', workerId: idOf('pane-chat'), choice: 'yes', since });
  expect(sent.at(-1)).toMatchObject({ action: 'answer', ok: false, error: 'no_terminal' });
  const n = sent.length;
  await actions.handle(page, { t: 'orca.answer', workerId: id, choice: 'rm -rf', since } as never);
  await actions.handle(page, { t: 'orca.answer', workerId: id, choice: 'yes' } as never);
  expect(sent.length).toBe(n);
  await flush();
  expect(sends).toEqual([]);
});

// ---- M7 B13: steering and resuming ------------------------------------------------------------

test('steering: Esc only into a working agent, the office’s own prompts with Enter', async () => {
  const id = idOf('pane-1');
  await actions.handle(page, { t: 'orca.steer', workerId: id, steer: 'interrupt' });
  await actions.handle(page, { t: 'orca.steer', workerId: id, steer: 'summarize' });
  await flush();
  expect(sends[0]).toEqual({ terminalId: T, text: '\x1b', enter: false });
  expect(sends[1]).toMatchObject({ terminalId: T, enter: true });
  expect(sends[1]!.text).toMatch(/^Pause for a moment and summarize/);
  // Done: no Esc, but "continue" goes.
  model.applyAgents('local', [agent('pane-1', 'a', { state: 'done' }), agent('pane-chat', 'b', { kind: 'chat' })], now);
  model.tick(now + 5000);
  model.building();
  await actions.handle(page, { t: 'orca.steer', workerId: id, steer: 'interrupt' });
  expect(sent.at(-1)).toMatchObject({ action: 'steer', ok: false, error: 'not_working' });
  await actions.handle(page, { t: 'orca.steer', workerId: id, steer: 'rm -rf /' } as never);
  await actions.handle(page, { t: 'orca.steer', workerId: idOf('pane-chat'), steer: 'continue' });
  expect(sent.at(-1)).toMatchObject({ action: 'steer', ok: false, error: 'no_terminal' });
  await flush();
  expect(sends).toHaveLength(2);
});

test("resume: the worktree's newest session nobody runs, through Orca's agent.resume", async () => {
  answers['agent.listSessions'] = { ok: true, value: { sessions: [
    { sessionId: 'old-1', agent: 'claude', updatedAt: 10, running: false, title: 'made-up' },
    { sessionId: 'new-2', agent: 'claude', updatedAt: 30, running: true, title: 'made-up' },
    { sessionId: 'mid-3', agent: 'codex', updatedAt: 20, running: false, title: 'made-up' },
  ], truncated: false } };
  await actions.handle(page, { t: 'orca.resume', deskId: seatOf('pane-1') });
  expect(calls.slice(-2)).toEqual([
    { method: 'agent.listSessions', params: { workspaceId: 'a', limit: 20 } },
    { method: 'agent.resume', params: { workspaceId: 'a', agent: 'codex', sessionId: 'mid-3' } },
  ]);
  expect(sent.at(-1)).toEqual({ t: 'orca.result', action: 'resume', ok: true, deskId: seatOf('pane-1') });
  // Nothing to resume: says so, starts nothing.
  answers['agent.listSessions'] = { ok: true, value: { sessions: [{ sessionId: 'x', agent: 'claude', updatedAt: 1, running: true }], truncated: false } };
  const n = calls.length;
  await actions.handle(page, { t: 'orca.resume', deskId: seatOf('pane-1') });
  expect(calls.slice(n).map((c) => c.method)).toEqual(['agent.listSessions']);
  expect(sent.at(-1)).toMatchObject({ action: 'resume', ok: false, error: 'nothing_to_resume' });
});

test('a turn that ended in a failure shows as failed until it works again (M7 B2)', async () => {
  const { parseStatusEvent } = await import('./orca.js');
  const id = idOf('pane-1');
  model.applyStatus(parseStatusEvent({ paneKey: 'pane-1', state: 'done', mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1 } }, now)!);
  model.tick(now + 5000);
  expect(model.building().floors[0]!.workers.find((w) => w.id === id)!.orca?.failed).toBe(true);
  model.applyStatus(parseStatusEvent({ paneKey: 'pane-1', state: 'working' }, now + 6000)!);
  expect(model.building().floors[0]!.workers.find((w) => w.id === id)!.orca?.failed).toBeUndefined();
});
