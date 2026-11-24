import './orca.css';
import { ORCA_AGENTS, ORCA_AGENT_LABELS, ORCA_LIMITS, type OrcaActionKind } from '@orca-office/shared/office/protocol/orca';
import type { ServerMsg, WorkerInfo } from '@orca-office/shared/office/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { STATUS_LABEL, h, openModal, toast } from './dom';
import { markdownChat } from './markdown';
import { routeBotMessage } from './bots';

/**
 * Light control over Orca from the office (M3, design #14): open a figure in Orca, a chat agent's
 * last words, mark a desk's worktree read, its comment, and a new task at an empty desk. The bridge
 * does the work (bridge/src/live/actions.ts); this is what you see of it.
 *
 * Only the live bridge (Orca behind it) says `orca`, so the stub office keeps agent-office's keys.
 */
let live = false;

/** Whether the office runs on Orca (the live bridge), not on the stub's made-up office. */
export function isOrca(): boolean {
  return live;
}

const ERRORS: Record<string, string> = {
  rate_limited: 'Slow down a little — too many at once',
  remote: 'That agent runs on another host; open it in Orca there',
  no_terminal: 'This agent has no terminal here',
  not_open: 'Open its terminal first',
  unknown_worker: 'That agent is gone',
  unknown_workspace: 'This desk is not an Orca worktree',
  plugin_offline: 'Orca is offline',
  timeout: 'Orca did not answer in time',
  cli_failed: 'The orca CLI failed',
  no_project: 'This floor has no Orca project on this machine',
  unknown_agent: 'Orca cannot start that agent',
  invalid_prompt: 'The prompt is empty or too long',
  invalid_name: 'The name may use letters, digits, ".", "_" and "-"',
  no_session: 'Orca has no session id for this chat yet',
  unreadable: 'Orca returned no conversation',
  no_agent_yet: 'The worktree is there, but no agent has sat down yet — check Orca',
  capability_denied: 'The orca-office plugin is not allowed to do that yet (approve its new capabilities)',
  not_allowed: 'The orca-office plugin does not allow that',
  unknown_chat: 'That chat is gone or closed — pick another',
  paused: 'This bot is paused in Orca',
  rate_limited_hour: 'That is 30 messages to bots this hour — try again later',
  invalid: 'Orca refused the message',
  not_sent: 'Orca did not take the message',
  failed: 'Something went wrong',
};
export const say = (e: string | undefined) => (e && ERRORS[e]) || `Orca said no${e ? ` (${e})` : ''}`;

const DONE: Partial<Record<OrcaActionKind, string>> = { open: '↗ Opened in Orca', read: '✓ Marked read', comment: '✓ Comment saved' };

/** Waiting for a desk's comment (orca.desk), and new tasks being started. */
const deskWaiters = new Map<string, (comment: string) => void>();
const creating = new Map<string, HTMLElement>();
let typeWarnedAt = 0;

/** Every server message passes here; picks out Orca's. */
export function routeOrcaMessage(msg: ServerMsg) {
  if (msg.t === 'orca') live = true;
  else if (msg.t === 'orca.result') {
    if (msg.ok) {
      const done = DONE[msg.action];
      if (done) toast(done);
      return;
    }
    // Typing errors come in a run: one toast a few seconds.
    if (msg.action === 'type') {
      if (Date.now() - typeWarnedAt < 3000) return;
      typeWarnedAt = Date.now();
    }
    if (msg.action === 'bot' && routeBotMessage(msg)) return;
    toast(say(msg.error), 'warn');
  } else if (msg.t === 'orca.chat') {
    if (msg.chatId !== undefined) routeBotMessage(msg);
    else if (chatPanel?.workerId === msg.workerId) chatPanel.show(msg);
  } else if (msg.t === 'orca.bot' || msg.t === 'orca.bot.sent') {
    routeBotMessage(msg);
  } else if (msg.t === 'orca.desk') {
    deskWaiters.get(msg.deskId)?.(msg.comment);
    deskWaiters.delete(msg.deskId);
  } else if (msg.t === 'orca.create') {
    const el = creating.get(msg.reqId);
    if (!el) return;
    if (msg.phase === 'creating') el.textContent = '⏳ Orca is making the worktree…';
    else if (msg.phase === 'created') el.textContent = '⏳ Worktree made — the agent is starting…';
    else {
      creating.delete(msg.reqId);
      el.classList.add(msg.phase === 'ready' ? 'ok' : 'bad');
      const floor = store.floors.find((f) => f.id === msg.floor);
      el.textContent = msg.phase === 'ready' ? `✅ It sat down${floor && msg.floor !== store.floor ? ` on ${floor.name}` : ''}` : `⚠️ ${say(msg.error)}`;
      setTimeout(() => el.remove(), 6000);
    }
  }
}

/** Shows the figure (or the desk's worktree) in Orca, its terminal focused. */
export function openInOrca(net: Net, target: { workerId: string } | { deskId: string }) {
  net.send({ t: 'orca.open', ...target });
}

/** The chat panel open now, which hears its `orca.chat` updates. */
let chatPanel: { workerId: string; show(msg: Extract<ServerMsg, { t: 'orca.chat' }>): void } | null = null;

/**
 * A chat agent (no terminal): its conversation, read-only (`orca agent read` through the bridge,
 * while the panel is open), the state of its latest turn, and the way to it in Orca. The text is
 * markdown, sanitized, with pictures left as their alt text so nothing is fetched from elsewhere.
 * Writing into a chat isn't possible (Orca has no API for it); the footer has room for it (M5, bots).
 */
export function openChatAgent(net: Net, w: WorkerInfo) {
  const remote = !!w.orca?.remote;
  const open = h('button.btn.primary', { type: 'button', onclick: () => (openInOrca(net, { workerId: w.id }), modal.close()) }, '↗ Open in Orca');
  const pill = h('span.pill', { class: w.status }, STATUS_LABEL[w.status] ?? w.status);
  const log = h('div.orca-log', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' }, h('p.orca-note', {}, remote ? 'This chat runs on another host.' : 'Loading the conversation…'));
  // Where a reply box goes once the office can write to a chat (M5); empty and hidden until then.
  const compose = h('div.orca-compose', { hidden: true });
  const el = h(
    'div.modal.orca-chat',
    { role: 'dialog', 'aria-label': `${w.name}, chat agent` },
    h('header', {}, h('span.dot', { style: `background:${w.color}` }), h('h2', {}, `💬 ${w.name} · ${w.task?.name ?? ''}`), pill),
    log,
    compose,
    h('footer', {}, h('span.grow', {}, remote ? 'Runs on another host' : 'Read-only: answer it in Orca'), remote ? null : open),
  );
  const modal = openModal(el, {
    doing: `💬 reading ${w.name}`,
    onClose: () => {
      if (chatPanel?.workerId === w.id) chatPanel = null;
      if (!remote) net.send({ t: 'orca.chat.close', workerId: w.id });
    },
  });
  if (remote) return;
  chatPanel = {
    workerId: w.id,
    show: (msg) => {
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      pill.className = `pill ${msg.state === 'working' ? 'working' : (store.workers.get(w.id)?.status ?? w.status)}`;
      pill.textContent = msg.state === 'working' ? 'working' : (STATUS_LABEL[store.workers.get(w.id)?.status ?? w.status] ?? msg.state ?? '');
      renderConversation(log, msg, w.name);
      if (atBottom) log.scrollTop = log.scrollHeight;
    },
  };
  net.send({ t: 'orca.chat.open', workerId: w.id });
  open.focus();
}

/** A conversation (`orca.chat`) into a log: messages as sanitized markdown, tools as chips. */
export function renderConversation(log: HTMLElement, msg: Extract<ServerMsg, { t: 'orca.chat' }>, name: string) {
  log.replaceChildren(
    ...(msg.limited ? [h('p.orca-note', {}, 'Older messages are in Orca.')] : []),
    ...msg.entries.map((e) =>
      'tool' in e
        ? h('div.orca-tool', {}, `🔧 ${e.tool}${e.state && e.state !== 'completed' ? ` · ${e.state}` : ''}`)
        : h(`div.orca-msg.${e.role}`, {}, h('div.orca-who', {}, e.role === 'assistant' ? name : !e.mail ? 'You' : e.mail.office ? 'You · from the office' : `📨 ${e.mail.from}`), chatText(e.text), e.shortened ? h('p.orca-note', {}, '…shortened; the rest is in Orca') : null),
    ),
    ...(msg.state === 'working' ? [h('p.orca-note.orca-typing', {}, `${name} is working…`)] : []),
    ...(msg.entries.length ? [] : [h('p.orca-note', {}, 'Nothing said yet.')]),
  );
}

/** A message's markdown, sanitized and without pictures (markdown.ts). */
function chatText(text: string): HTMLElement {
  const el = markdownChat(text);
  el.classList.add('orca-md');
  return el;
}

/** Edits the comment Orca keeps on a desk's worktree. */
export function openComment(net: Net, deskId: string, deskName: string) {
  const ta = h('textarea', { rows: 4, maxlength: ORCA_LIMITS.comment, placeholder: 'Loading…', 'aria-label': 'Comment', disabled: true }) as HTMLTextAreaElement;
  const save = h('button.btn.primary', { type: 'submit', disabled: true }, 'Save');
  const form = h(
    'form.modal.orca-comment',
    { role: 'dialog', 'aria-label': `Comment on ${deskName}` },
    h('header', {}, h('h2', {}, `🗒️ ${deskName}`)),
    h('div.body', {}, h('label', {}, 'Comment in Orca'), ta, h('p.orca-note', {}, 'Shown on the worktree in Orca’s sidebar. Leave it empty to clear it.')),
    h('footer', {}, h('span.grow', {}), save),
  ) as HTMLFormElement;
  deskWaiters.set(deskId, (comment) => {
    ta.value = comment;
    ta.placeholder = 'What is this worktree waiting on?';
    ta.disabled = false;
    save.disabled = false;
    ta.focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (save.disabled) return;
    net.send({ t: 'orca.comment', deskId, comment: ta.value });
    modal.close();
  });
  const modal = openModal(form, { onClose: () => deskWaiters.delete(deskId) });
  net.send({ t: 'orca.desk', deskId });
}

/** A new task at an empty desk: a new worktree in a repository, an agent, its first prompt. */
export function openNewTask(net: Net, deskName: string) {
  const floors = store.floors.filter((f) => f.orcaCreate);
  if (!floors.length) return toast(say('no_project'), 'warn');
  const repo = h('select', { 'aria-label': 'Repository' }, ...floors.map((f) => h('option', { value: f.id, selected: f.id === store.floor }, f.name))) as HTMLSelectElement;
  const agent = h('select', { 'aria-label': 'Agent' }, ...ORCA_AGENTS.map((a) => h('option', { value: a }, ORCA_AGENT_LABELS[a] ?? a))) as HTMLSelectElement;
  const name = h('input', { type: 'text', maxlength: ORCA_LIMITS.name, placeholder: 'Optional: worktree name', 'aria-label': 'Worktree name', autocomplete: 'off', pattern: '[A-Za-z0-9][A-Za-z0-9._\\-]*' }) as HTMLInputElement;
  const prompt = h('textarea', { rows: 6, maxlength: ORCA_LIMITS.prompt, placeholder: 'What should the agent work on?', 'aria-label': 'Prompt', required: true }) as HTMLTextAreaElement;
  const go = h('button.btn.primary', { type: 'submit' }, '✨ Start');
  const form = h(
    'form.modal.orca-new',
    { role: 'dialog', 'aria-label': 'New task' },
    h('header', {}, h('h2', {}, `✨ New task at ${deskName}`)),
    h(
      'div.body',
      {},
      h('div.orca-row', {}, h('div', {}, h('label', {}, 'Repository'), repo), h('div', {}, h('label', {}, 'Agent'), agent)),
      h('label', {}, 'Worktree'),
      name,
      h('label', { style: 'margin-top:12px' }, 'Prompt'),
      prompt,
      h('p.orca-note', {}, 'Orca makes a new branch and worktree in that repository and starts the agent there.'),
    ),
    h('footer', {}, h('span.grow', {}), go),
  ) as HTMLFormElement;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = prompt.value.trim();
    if (!text) return prompt.focus();
    const reqId = crypto.randomUUID().slice(0, 18);
    // A line of its own in the toasts, which stays until the task is ready or fails (routeOrcaMessage).
    const status = h('div.toast.orca-progress', {}, '⏳ Starting…');
    document.getElementById('toasts')?.append(status);
    creating.set(reqId, status);
    net.send({ t: 'orca.create', reqId, floor: repo.value, agent: agent.value, prompt: text, ...(name.value.trim() ? { name: name.value.trim() } : {}) });
    modal.close();
  });
  const modal = openModal(form, { doing: '✨ starting a task' });
  prompt.focus();
}
