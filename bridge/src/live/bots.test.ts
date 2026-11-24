import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ServerMsg } from '@orca-office/shared/office/protocol';
import { ORCA_LIMITS } from '@orca-office/shared/office/protocol/orca';
import { pageLimits } from '../rate.js';
import { BOT_CHAT_EVERY_MS, BOT_SENDS_PER_HOUR, BotChats, NEW_CHAT_EVERY_MS, subjectOf } from './bots.js';
import { OFFICE_SENDER, orcaBotSend } from './cli.js';
import { LiveModel, botWorkerId } from './model.js';
import { parseBotChats, parseConversation, unwrapMail } from './orca.js';

// Made-up Orca only: fake bots, chat ids and text.

const BOT = { id: 'b-1', name: 'DemoBot', agent: 'claude', paused: false, specialty: null };
const PAUSED = { id: 'b-2', name: 'NapBot', agent: 'claude', paused: true, specialty: null };
const W = botWorkerId(BOT);

let now = 1_000_000;
let chats: Record<string, unknown>[];
let cliCalls: string[][];
let sends: { bot: string; chatId: string; subject: string; body: string }[];
let sendResult: true | string;
let model: LiveModel;
let bots: BotChats;
let sent: ServerMsg[];
let page: { floor: () => string | undefined; send: (m: ServerMsg[]) => void; limits: ReturnType<typeof pageLimits> };

const chat = (id: string, over: Record<string, unknown> = {}) => ({ id, title: `Made-up ${id}`, home: false, self: false, closed: false, lastActivityAt: 1, lastAsked: 'made-up asked', lastSaid: 'made-up said', ...over });
const conversation = { ok: true, result: { state: 'done', limited: false, entries: [{ kind: 'message', role: 'assistant', text: 'Made-up answer' }] } };

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000_000;
  chats = [chat('c-home', { home: true, lastActivityAt: 5 }), chat('c-old', { lastActivityAt: 2 }), chat('c-new', { lastActivityAt: 9 }), chat('c-closed', { closed: true }), chat('c-self', { self: true })];
  cliCalls = [];
  sends = [];
  sendResult = true;
  sent = [];
  model = new LiveModel();
  model.applyBots([BOT, PAUSED]);
  bots = new BotChats(model, {
    cli: async (args) => (cliCalls.push(args), args[0] === 'bot' ? { ok: true, result: { chats } } : conversation),
    sendBot: async (bot, chatId, subject, body) => (sends.push({ bot, chatId, subject, body }), sendResult),
    now: () => now,
  });
  page = { floor: () => undefined, send: (m) => sent.push(...m), limits: pageLimits(now) };
});
afterEach(() => vi.useRealTimers());

const flush = () => vi.advanceTimersByTimeAsync(0);
const of = <T extends ServerMsg['t']>(t: T) => sent.filter((m): m is Extract<ServerMsg, { t: T }> => m.t === t);
const send = (over: Record<string, unknown> = {}) => bots.handle(page, { t: 'orca.bot.send', workerId: W, reqId: 'r1', chatId: 'c-home', text: 'Made-up question\nwith a second line', ...over } as never);

test('a bot figure says it is a bot, and the model finds the bot by figure', () => {
  const staff = model.building().floors.find((f) => f.info.room === 'staff')!;
  expect(staff.workers.find((w) => w.id === W)!.orca).toEqual({ terminal: false, remote: false, bot: 'DemoBot' });
  expect(model.botOf(W)).toEqual(BOT);
  expect(model.botOf('bot-nope')).toBeNull();
});

test('bot chats: ids, cut titles and flags; what the bot was asked and said is dropped', () => {
  const list = parseBotChats({ ok: true, result: { chats: [chat('a', { title: 'x'.repeat(200) }), { id: '-flag' }, { title: 'no id' }] } });
  expect(list).toHaveLength(1);
  expect(list[0]!.title!.length).toBeLessThanOrEqual(60);
  expect(JSON.stringify(list)).not.toContain('made-up');
});

test('opening a bot lists its open chats, Home first then newest, and only resends on change', async () => {
  await bots.handle(page, { t: 'orca.bot.open', workerId: W });
  expect(cliCalls[0]).toEqual(['bot', 'chats', '--bot', 'DemoBot', '--json']);
  expect(of('orca.bot')).toHaveLength(1);
  expect(of('orca.bot')[0]!.chats.map((c) => c.id)).toEqual(['c-home', 'c-new', 'c-old']);
  expect(JSON.stringify(sent)).not.toContain('made-up asked');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(of('orca.bot')).toHaveLength(1);
  chats.push(chat('c-more', { lastActivityAt: 99 }));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(of('orca.bot')).toHaveLength(2);
});

test('only a bot opens; a chat must be one of its open chats', async () => {
  await bots.handle(page, { t: 'orca.bot.open', workerId: 'w-agent' });
  expect(sent.at(-1)).toMatchObject({ t: 'orca.result', action: 'bot', ok: false, error: 'unknown_worker' });
  await bots.handle(page, { t: 'orca.bot.open', workerId: W });
  for (const chatId of ['c-closed', 'c-self', 'c-unknown']) {
    await bots.handle(page, { t: 'orca.bot.chat', workerId: W, chatId });
    expect(sent.at(-1)).toMatchObject({ ok: false, error: 'unknown_chat' });
  }
  await bots.handle(page, { t: 'orca.bot.chat', workerId: W, chatId: 'c-old' });
  expect(cliCalls.at(-1)).toEqual(['agent', 'read', 'c-old', '--json', '--limit', '50']);
  expect(sent.at(-1)).toMatchObject({ t: 'orca.chat', workerId: W, chatId: 'c-old', state: 'done' });
  // Read again while shown; stops when the panel closes.
  const reads = () => cliCalls.filter((a) => a[0] === 'agent').length;
  await vi.advanceTimersByTimeAsync(BOT_CHAT_EVERY_MS);
  expect(reads()).toBe(2);
  await bots.handle(page, { t: 'orca.bot.close', workerId: W });
  await vi.advanceTimersByTimeAsync(BOT_CHAT_EVERY_MS * 3);
  expect(reads()).toBe(2);
});

test('a message goes to the open bot and chat, as a handoff, subject from its first line', async () => {
  await bots.handle(page, { t: 'orca.bot.open', workerId: W });
  await send();
  expect(sends).toEqual([{ bot: 'DemoBot', chatId: 'c-home', subject: 'Made-up question', body: 'Made-up question\nwith a second line' }]);
  expect(of('orca.bot.sent').map((m) => m.phase)).toEqual(['sending', 'sent']);
  expect(of('orca.bot.sent').at(-1)).toMatchObject({ chatId: 'c-home', reqId: 'r1' });
});

test('a message is refused unless every check passes, and nothing is sent', async () => {
  await send();
  expect(of('orca.bot.sent').at(-1)).toMatchObject({ phase: 'failed', error: 'not_open' });
  await bots.handle(page, { t: 'orca.bot.open', workerId: W });
  for (const [over, error] of [
    [{ text: '   ' }, 'invalid_prompt'],
    [{ text: 'x'.repeat(ORCA_LIMITS.prompt + 1) }, 'invalid_prompt'],
    [{ text: 'a\0b' }, 'invalid_prompt'],
    [{ chatId: '--to=bot:Other' }, 'unknown_chat'],
    [{ chatId: 'c-closed' }, 'unknown_chat'],
  ] as const) {
    now += 10_000;
    await send(over);
    expect(of('orca.bot.sent').at(-1)).toMatchObject({ phase: 'failed', error });
  }
  expect(sends).toEqual([]);
  // A paused bot.
  await bots.handle(page, { t: 'orca.bot.open', workerId: botWorkerId(PAUSED) });
  await bots.handle(page, { t: 'orca.bot.send', workerId: botWorkerId(PAUSED), reqId: 'r2', chatId: 'c-home', text: 'Made-up' });
  expect(of('orca.bot.sent').at(-1)).toMatchObject({ phase: 'failed', error: 'paused' });
  expect(sends).toEqual([]);
});

test('one message every 5 s and 200 an hour, for the whole bridge', async () => {
  await bots.handle(page, { t: 'orca.bot.open', workerId: W });
  await send();
  await send();
  expect(of('orca.bot.sent').at(-1)).toMatchObject({ phase: 'failed', error: 'rate_limited' });
  // Another page shares the limit.
  const other = { floor: () => undefined, send: (m: ServerMsg[]) => sent.push(...m), limits: pageLimits(now) };
  await bots.handle(other, { t: 'orca.bot.open', workerId: W });
  await bots.handle(other, { t: 'orca.bot.send', workerId: W, reqId: 'r9', chatId: 'c-home', text: 'Made-up' });
  expect(of('orca.bot.sent').at(-1)).toMatchObject({ phase: 'failed', error: 'rate_limited' });
  for (let i = 0; i < 40; i++) {
    now += 5_000;
    await send();
  }
  expect(sends).toHaveLength(41);
  // One every 5 s drains the hour's 200 (refilling ~0.28 per send) after ~250 more.
  for (let i = 0; i < 400 && of('orca.bot.sent').at(-1)?.error !== 'rate_limited_hour'; i++) {
    now += 5_000;
    await send();
  }
  expect(sends.length).toBeGreaterThan(BOT_SENDS_PER_HOUR);
  expect(sends.length).toBeLessThan(BOT_SENDS_PER_HOUR * 1.5);
  expect(of('orca.bot.sent').at(-1)).toMatchObject({ phase: 'failed', error: 'rate_limited_hour' });
});

test('a CLI refusal comes back as its code', async () => {
  await bots.handle(page, { t: 'orca.bot.open', workerId: W });
  sendResult = 'no_active_sender_terminal';
  await send();
  expect(of('orca.bot.sent').at(-1)).toMatchObject({ phase: 'failed', error: 'no_active_sender_terminal' });
});

test('a new chat: its id is the one that turns up in the list, and it is shown', async () => {
  await bots.handle(page, { t: 'orca.bot.open', workerId: W });
  const done = send({ chatId: 'new' });
  await flush();
  expect(sends[0]).toMatchObject({ chatId: 'new' });
  await vi.advanceTimersByTimeAsync(NEW_CHAT_EVERY_MS);
  chats.push(chat('c-fresh', { lastActivityAt: 100 }));
  await vi.advanceTimersByTimeAsync(NEW_CHAT_EVERY_MS);
  await done;
  expect(of('orca.bot.sent').at(-1)).toMatchObject({ phase: 'sent', chatId: 'c-fresh' });
  expect(of('orca.bot').at(-1)!.chats.map((c) => c.id)).toContain('c-fresh');
  expect(sent.at(-1)).toMatchObject({ t: 'orca.chat', chatId: 'c-fresh' });
});

test('nothing a bot is told or says is logged', async () => {
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
  await bots.handle(page, { t: 'orca.bot.open', workerId: W });
  await bots.handle(page, { t: 'orca.bot.chat', workerId: W, chatId: 'c-home' });
  await send();
  for (const l of logs) expect(l).not.toHaveBeenCalled();
});

test('subject: the first non-empty line, one line, cut to 60', () => {
  expect(subjectOf('\n\n  Hello there  \nmore')).toBe('Hello there');
  expect(subjectOf('y'.repeat(100)).length).toBe(60);
});

test('orcaBotSend: argument array with the office as sender, the body on stdin only', async () => {
  vi.useRealTimers();
  const dir = mkdtempSync(join(tmpdir(), 'orca-office-test-'));
  try {
    const bin = join(dir, 'orca');
    // Answers ok only for exactly the expected arguments and stdin.
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const want = ['orchestration','send','--from','${OFFICE_SENDER}','--to','bot:DemoBot','--chat','new','--type','handoff','--subject=-x Made-up','--body-file','-','--json'];
const body = require('fs').readFileSync(0, 'utf8');
const ok = JSON.stringify(process.argv.slice(2)) === JSON.stringify(want) && body === 'Made-up $(body)';
console.log(JSON.stringify(ok ? { ok: true, result: { messageId: 'msg_1' } } : { ok: false, error: { code: 'bad_args' } }));
process.exit(ok ? 0 : 1);
`,
    );
    chmodSync(bin, 0o755);
    const sendBot = orcaBotSend(bin);
    expect(await sendBot('DemoBot', 'new', '-x Made-up', 'Made-up $(body)')).toBe(true);
    expect(await sendBot('DemoBot', 'new', '-x Made-up', 'other')).toBe('bad_args');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Orca mail in a chat: header, subject, payload and reply lines come off; who sent it stays', () => {
  const rule = '─'.repeat(60);
  const office = `──── From: ORCA-OFFICE (orca-office) (handoff) ────\nSubject: Made-up\nMade-up body\nsecond line\n[Payload: {"botRequest":{}}]\n[Reply: orca orchestration reply --id msg_x]\n${rule}`;
  expect(unwrapMail(office)).toEqual({ from: { office: true }, text: 'Made-up body\nsecond line' });
  expect(unwrapMail('──── From: DEMOBOT (orca_session_id:abc) (question) ────\nSubject: Hi\nMade-up')).toEqual({ from: { office: false, from: 'DEMOBOT' }, text: 'Made-up' });
  expect(unwrapMail('Just a made-up message')).toBeNull();
  const c = parseConversation({ ok: true, result: { state: 'done', entries: [{ kind: 'message', role: 'user', text: office }, { kind: 'message', role: 'assistant', text: office }] } });
  expect(c!.entries[0]).toEqual({ role: 'user', text: 'Made-up body\nsecond line', mail: { office: true } });
  // Only a user turn is mail.
  expect(c!.entries[1]).toMatchObject({ role: 'assistant', text: office });
});
