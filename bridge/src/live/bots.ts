/**
 * Talking to bots from the office (M5, #37; route in docs/m5-bots.md). A bot's figure opens its
 * chats: the list (`orca bot chats`), one chat's conversation (`orca agent read <chat id>`, the
 * same read-only view as M3's chat panel) and a box to write to it (`orca orchestration send
 * --to bot:<name> --type handoff`), into that chat or a new one.
 *
 * Checked here before anything reaches the CLI: the page has that bot open, the bot is one of
 * `orca bot list` and not paused, the chat is one of `orca bot chats` for it (read again right
 * before sending) or `new`, the text is 1–ORCA_LIMITS.prompt characters. One message every 5 s and
 * 200 an hour for the whole bridge. Message text, titles and answers are never logged or kept:
 * they pass to the one page that has the panel open; errors are short codes.
 */
import { toBubble } from '@orca-office/shared';
import { ORCA_BOT_CHATS, ORCA_LIMITS, ORCA_NEW_CHAT, type OrcaBotChat } from '@orca-office/shared/office/protocol/orca';
import type { ClientMsg, ServerMsg } from '@orca-office/shared/office/protocol';
import { Bucket } from '../rate.js';
import type { ActionPage } from './actions.js';
import type { LiveModel } from './model.js';
import { CHAT_ID, parseBotChats, parseConversation, type CliBotChat } from './orca.js';

/** How often an open bot's chat list is read again, and the shown chat's conversation. */
export const BOT_CHATS_EVERY_MS = 10_000;
export const BOT_CHAT_EVERY_MS = 3_000;
/** After a message to a new chat: how often to look for it in the bot's list, and for how long. */
export const NEW_CHAT_EVERY_MS = 1_500;
export const NEW_CHAT_WAIT_MS = 30_000;
/** A message subject (a new chat's title): the text's first line, this long at most. */
export const SUBJECT_MAX = 60;

export interface BotDeps {
  /** `orca <args>` with JSON out; rejects with a short reason. */
  cli(args: string[]): Promise<unknown>;
  /** `orca orchestration send` to a bot (cli.ts orcaBotSend): true, or a short code. */
  sendBot(bot: string, chatId: string, subject: string, body: string): Promise<true | string>;
  now(): number;
}

interface OpenBot {
  workerId: string;
  bot: string;
  chats: CliBotChat[];
  /** What the page was last sent as the list, to send it only when it changes. */
  listKey: string;
  timer: ReturnType<typeof setInterval>;
  /** The chat shown, and how to stop reading it. */
  chat: { id: string; stop: () => void; read: () => Promise<void> } | null;
  closed: boolean;
}

const MESSAGES = new Set(['orca.bot.open', 'orca.bot.chat', 'orca.bot.close', 'orca.bot.send']);

/** Bot messages the bridge lets through per hour, all pages together. */
export const BOT_SENDS_PER_HOUR = 200;

export class BotChats {
  private pages = new Map<ActionPage, OpenBot>();
  /** For the whole bridge, whichever page sends: 1 message in 5 s (no double sends), 200 an hour (a runaway loop stops). */
  private burst: Bucket;
  private hourly: Bucket;

  constructor(
    private model: LiveModel,
    private deps: BotDeps,
  ) {
    this.burst = new Bucket(1, 1 / 5, deps.now());
    this.hourly = new Bucket(BOT_SENDS_PER_HOUR, BOT_SENDS_PER_HOUR / 3600, deps.now());
  }

  static handles(t: string): boolean {
    return MESSAGES.has(t);
  }

  closed(page: ActionPage): void {
    this.close(page);
  }

  async handle(page: ActionPage, msg: ClientMsg): Promise<void> {
    switch (msg.t) {
      case 'orca.bot.open':
        return this.open(page, msg.workerId);
      case 'orca.bot.chat':
        return this.show(page, msg.workerId, msg.chatId);
      case 'orca.bot.close':
        if (this.pages.get(page)?.workerId === msg.workerId) this.close(page);
        return;
      case 'orca.bot.send':
        return this.send(page, msg);
    }
  }

  // ---- the panel ------------------------------------------------------------------------------

  private async open(page: ActionPage, workerId: unknown) {
    if (typeof workerId !== 'string') return;
    this.close(page);
    const bot = this.model.botOf(workerId);
    if (!bot) return void page.send([fail('unknown_worker', workerId)]);
    if (!page.limits.other.take()) return void page.send([fail('rate_limited', workerId)]);
    const st: OpenBot = { workerId, bot: bot.name, chats: [], listKey: '', timer: setInterval(() => void this.list(page, st), BOT_CHATS_EVERY_MS), chat: null, closed: false };
    this.pages.set(page, st);
    await this.list(page, st);
  }

  private close(page: ActionPage) {
    const st = this.pages.get(page);
    if (!st) return;
    st.closed = true;
    clearInterval(st.timer);
    st.chat?.stop();
    this.pages.delete(page);
  }

  /** Reads the bot's chats; sends them to the page when they changed. The chats, or null when the CLI failed. */
  private async list(page: ActionPage, st: OpenBot): Promise<CliBotChat[] | null> {
    let chats: CliBotChat[];
    try {
      chats = await this.readChats(st.bot);
    } catch {
      if (!st.closed) page.send([fail('cli_failed', st.workerId)]);
      return null;
    }
    if (st.closed) return chats;
    st.chats = chats;
    const shown: OrcaBotChat[] = chats
      .filter((c) => !c.closed && !c.self)
      .sort((a, b) => Number(b.home) - Number(a.home) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      .slice(0, ORCA_BOT_CHATS)
      .map(({ id, title, home, lastActivityAt }) => ({ id, title, home, lastActivityAt }));
    const msg: ServerMsg = { t: 'orca.bot', workerId: st.workerId, bot: st.bot, chats: shown };
    const key = JSON.stringify(msg);
    if (key !== st.listKey) {
      st.listKey = key;
      page.send([msg]);
    }
    return chats;
  }

  private async readChats(bot: string): Promise<CliBotChat[]> {
    return parseBotChats(await this.deps.cli(['bot', 'chats', '--bot', bot, '--json']));
  }

  /** Shows one of the open bot's chats: its conversation now and every few seconds while shown. */
  private show(page: ActionPage, workerId: unknown, chatId: unknown) {
    const st = this.pages.get(page);
    if (!st || st.workerId !== workerId || typeof chatId !== 'string') return;
    if (!st.chats.some((c) => c.id === chatId && !c.closed && !c.self)) return void page.send([fail('unknown_chat', st.workerId)]);
    return this.watch(page, st, chatId);
  }

  private watch(page: ActionPage, st: OpenBot, chatId: string): Promise<void> {
    st.chat?.stop();
    let last = '';
    let busy = false;
    let stopped = false;
    const read = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const c = parseConversation(await this.deps.cli(['agent', 'read', chatId, '--json', '--limit', '50']));
        if (stopped) return;
        if (!c) return void page.send([fail('unreadable', st.workerId)]);
        const msg: ServerMsg = { t: 'orca.chat', workerId: st.workerId, chatId, ...c };
        const key = JSON.stringify(msg);
        if (key !== last) {
          last = key;
          page.send([msg]);
        }
      } catch {
        if (!stopped) page.send([fail('cli_failed', st.workerId)]);
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void read(), BOT_CHAT_EVERY_MS);
    st.chat = { id: chatId, read, stop: () => ((stopped = true), clearInterval(timer)) };
    return read();
  }

  // ---- writing --------------------------------------------------------------------------------

  private async send(page: ActionPage, msg: Extract<ClientMsg, { t: 'orca.bot.send' }>) {
    const { workerId, reqId, chatId, text } = msg;
    if (typeof reqId !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(reqId) || typeof workerId !== 'string') return;
    const say = (phase: 'sending' | 'sent' | 'failed', extra: { chatId?: string; error?: string } = {}) => page.send([{ t: 'orca.bot.sent', workerId, reqId, phase, ...extra }]);
    const st = this.pages.get(page);
    if (!st || st.workerId !== workerId) return say('failed', { error: 'not_open' });
    if (typeof text !== 'string' || !text.trim() || text.length > ORCA_LIMITS.prompt || text.includes('\0')) return say('failed', { error: 'invalid_prompt' });
    if (typeof chatId !== 'string' || (chatId !== ORCA_NEW_CHAT && !CHAT_ID.test(chatId))) return say('failed', { error: 'unknown_chat' });
    // The bot as `orca bot list` has it now (the model's last read of it), and not paused.
    const bot = this.model.botOf(workerId);
    if (!bot || bot.name !== st.bot || this.model.botNamed(bot.name) !== bot) return say('failed', { error: 'unknown_worker' });
    if (bot.paused) return say('failed', { error: 'paused' });
    if (bot.name.startsWith('-')) return say('failed', { error: 'unknown_worker' });
    const now = this.deps.now();
    if (!this.burst.take(1, now)) return say('failed', { error: 'rate_limited' });
    if (!this.hourly.take(1, now)) return say('failed', { error: 'rate_limited_hour' });
    // The chat, against the bot's chats read right now.
    let before: CliBotChat[];
    try {
      before = await this.readChats(bot.name);
    } catch {
      return say('failed', { error: 'cli_failed' });
    }
    if (chatId !== ORCA_NEW_CHAT && !before.some((c) => c.id === chatId && !c.closed && !c.self)) return say('failed', { error: 'unknown_chat' });
    say('sending');
    const r = await this.deps.sendBot(bot.name, chatId, subjectOf(text), text);
    if (r !== true) return say('failed', { error: r });
    if (chatId !== ORCA_NEW_CHAT) {
      say('sent', { chatId });
      if (!st.closed && st.chat?.id === chatId) void st.chat.read();
      if (!st.closed) void this.list(page, st);
      return;
    }
    // A new chat: Orca doesn't say its id, so it is the one that wasn't in the list before.
    const known = new Set(before.map((c) => c.id));
    const until = this.deps.now() + NEW_CHAT_WAIT_MS;
    while (!st.closed) {
      const chats = await this.list(page, st);
      const fresh = chats?.find((c) => !known.has(c.id) && !c.self);
      if (fresh) {
        say('sent', { chatId: fresh.id });
        return this.watch(page, st, fresh.id);
      }
      if (this.deps.now() >= until) break;
      await new Promise((resolve) => setTimeout(resolve, NEW_CHAT_EVERY_MS));
    }
    say('sent');
  }
}

/** A message's subject (Orca titles a new chat with it): its first non-empty line, cut short. */
export function subjectOf(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return toBubble(line, SUBJECT_MAX) ?? 'Message from the office';
}

function fail(error: string, workerId: string): ServerMsg {
  return { t: 'orca.result', action: 'bot', ok: false, error, workerId };
}
