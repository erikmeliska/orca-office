import './bots.css';
import { ORCA_LIMITS, ORCA_NEW_CHAT, type OrcaBotChat } from '@orca-office/shared/office/protocol/orca';
import type { ServerMsg, WorkerInfo } from '@orca-office/shared/office/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { STATUS_LABEL, h, openModal } from './dom';
import { renderConversation, say } from './orca';

/**
 * A bot's chats (M5, #37): click a bot on the Staff floor (or at the head of a project room) and
 * its chats open: the Home Chat and the others as tabs, the chosen one's conversation (read-only,
 * like M3's chat panel), and a box to write to the bot, into that chat or a new one. The bridge
 * sends it with `orca orchestration send --type handoff` (bridge/src/live/bots.ts) and the answer
 * shows up as the conversation is read again: sent → the bot is working → it answered.
 */

type ChatMsg = Extract<ServerMsg, { t: 'orca.chat' }>;
type BotMsg = Extract<ServerMsg, { t: 'orca.bot' }> | Extract<ServerMsg, { t: 'orca.bot.sent' }> | ChatMsg | Extract<ServerMsg, { t: 'orca.result' }>;

interface Panel {
  workerId: string;
  /** Takes a message for this panel; true when it was one. */
  take(msg: BotMsg): boolean;
}

let panel: Panel | null = null;

/** Messages for the bot panel (from routeOrcaMessage); true when the open panel took it. */
export function routeBotMessage(msg: BotMsg): boolean {
  if (!panel || !('workerId' in msg) || msg.workerId !== panel.workerId) return false;
  return panel.take(msg);
}

/** Where a message to the bot stands, shown under the box. */
type Progress = { phase: 'sending' } | { phase: 'sent'; chatId: string | null; base: number; worked: boolean } | { phase: 'answered' } | { phase: 'failed'; error: string };

export function openBotChat(net: Net, w: WorkerInfo) {
  const bot = w.orca?.bot ?? w.name;
  let chats: OrcaBotChat[] = [];
  /** The chat shown: an id, ORCA_NEW_CHAT (writing starts one), or null before the list came. */
  let current: string | null = null;
  let conversation: ChatMsg | null = null;
  let progress: Progress | null = null;
  let reqId: string | null = null;

  const pill = h('span.pill', { class: w.status }, STATUS_LABEL[w.status] ?? w.status);
  const tabs = h('div.bot-tabs', { role: 'tablist', 'aria-label': `${bot}'s chats` });
  const log = h('div.orca-log', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' }, h('p.orca-note', {}, 'Loading the chats…'));
  const box = h('textarea', { rows: 3, maxlength: ORCA_LIMITS.prompt, placeholder: `Write to ${bot}…`, 'aria-label': `Message to ${bot}` }) as HTMLTextAreaElement;
  const go = h('button.btn.primary', { type: 'submit' }, 'Send');
  const status = h('p.bot-status', { role: 'status', 'aria-live': 'polite' });
  const compose = h('form.bot-compose', {}, box, h('div.bot-send', {}, status, go)) as HTMLFormElement;
  const el = h(
    'div.modal.orca-chat.bot-chat',
    { role: 'dialog', 'aria-label': `${bot}, bot` },
    h('header', {}, h('span.dot', { style: `background:${w.color}` }), h('h2', {}, `🤖 ${bot}`), pill),
    tabs,
    log,
    compose,
    h('footer', {}, h('span.grow', {}, `Goes to ${bot} as a handoff in this chat · Enter sends, Shift+Enter is a new line`)),
  );

  const modal = openModal(el, {
    doing: `🤖 talking to ${bot}`,
    onClose: () => {
      if (panel?.workerId === w.id) panel = null;
      net.send({ t: 'orca.bot.close', workerId: w.id });
    },
  });

  function drawTabs() {
    const tab = (id: string, label: string, title?: string) =>
      h('button.bot-tab', { type: 'button', role: 'tab', 'aria-selected': String(id === current), class: id === current ? 'on' : '', title: title ?? label, onclick: () => pick(id) }, label);
    tabs.replaceChildren(...chats.map((c) => tab(c.id, c.home ? '🏠 Home' : (c.title ?? 'Untitled'), c.title ?? undefined)), tab(ORCA_NEW_CHAT, '＋ New chat', 'Start a new chat with this message'));
  }

  function pick(id: string) {
    if (id === current) return;
    current = id;
    conversation = null;
    drawTabs();
    if (id === ORCA_NEW_CHAT) {
      log.replaceChildren(h('p.orca-note', {}, `A new chat on ${bot}: its first line becomes the chat's title.`));
    } else {
      log.replaceChildren(h('p.orca-note', {}, 'Loading the conversation…'));
      net.send({ t: 'orca.bot.chat', workerId: w.id, chatId: id });
    }
    box.focus();
  }

  function drawStatus() {
    status.className = `bot-status ${progress?.phase ?? ''}`;
    const p = progress;
    status.textContent = !p
      ? ''
      : p.phase === 'sending'
        ? '⏳ Sending…'
        : p.phase === 'sent'
          ? p.worked
            ? `✍️ ${bot} is working…`
            : `✓ Sent — waiting for ${bot}`
          : p.phase === 'answered'
            ? `✅ ${bot} answered`
            : `⚠️ ${say(p.error)}`;
    go.disabled = p?.phase === 'sending';
  }

  const answers = (m: ChatMsg | null) => (m ? m.entries.filter((e) => 'role' in e && e.role === 'assistant').length : 0);

  /** A fresh read of the shown chat moves a sent message on: working, then answered. */
  function follow() {
    const p = progress;
    if (p?.phase !== 'sent' || !conversation || p.chatId !== conversation.chatId) return;
    if (conversation.state === 'working') p.worked = true;
    else if (p.worked || answers(conversation) > p.base) progress = { phase: 'answered' };
    drawStatus();
  }

  compose.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text || !current || progress?.phase === 'sending') return box.focus();
    reqId = crypto.randomUUID().slice(0, 18);
    progress = { phase: 'sending' };
    drawStatus();
    net.send({ t: 'orca.bot.send', workerId: w.id, reqId, chatId: current, text });
  });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      compose.requestSubmit();
    }
  });

  panel = {
    workerId: w.id,
    take(msg) {
      if (msg.t === 'orca.bot') {
        chats = msg.chats;
        if (current === null || (current !== ORCA_NEW_CHAT && !chats.some((c) => c.id === current))) {
          current = null;
          const first = chats.find((c) => c.home) ?? chats[0];
          if (first) pick(first.id);
          else pick(ORCA_NEW_CHAT);
        } else drawTabs();
        return true;
      }
      if (msg.t === 'orca.chat') {
        if (msg.chatId !== current) return true;
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        conversation = msg;
        renderConversation(log, msg, bot);
        pill.className = `pill ${msg.state === 'working' ? 'working' : (store.workers.get(w.id)?.status ?? w.status)}`;
        pill.textContent = msg.state === 'working' ? 'working' : (STATUS_LABEL[store.workers.get(w.id)?.status ?? w.status] ?? msg.state ?? '');
        if (atBottom) log.scrollTop = log.scrollHeight;
        follow();
        return true;
      }
      if (msg.t === 'orca.bot.sent') {
        if (msg.reqId !== reqId) return true;
        if (msg.phase === 'sending') progress = { phase: 'sending' };
        else if (msg.phase === 'failed') progress = { phase: 'failed', error: msg.error ?? 'failed' };
        else {
          box.value = '';
          const to = msg.chatId ?? null;
          // What the chat said before this message: a new chat had nothing.
          progress = { phase: 'sent', chatId: to, base: to && conversation?.chatId === to ? answers(conversation) : 0, worked: false };
          if (to && to !== current) {
            current = to;
            conversation = null;
            drawTabs();
          }
        }
        drawStatus();
        follow();
        return true;
      }
      // An error from the bridge about this bot (the list or the chat couldn't be read).
      if (msg.t === 'orca.result' && !msg.ok) {
        progress = { phase: 'failed', error: msg.error ?? 'failed' };
        drawStatus();
        return true;
      }
      return false;
    },
  };
  drawTabs();
  net.send({ t: 'orca.bot.open', workerId: w.id });
  box.focus();
  void modal;
}
