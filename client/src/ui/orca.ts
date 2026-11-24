import './orca.css';
import { ORCA_AGENTS, ORCA_LIMITS, type OrcaActionKind } from '@orca-office/shared/office/protocol/orca';
import type { ServerMsg, WorkerInfo } from '@orca-office/shared/office/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { STATUS_LABEL, h, openModal, toast } from './dom';

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
  no_agent_yet: 'The worktree is there, but no agent has sat down yet — check Orca',
  capability_denied: 'The orca-office plugin is not allowed to do that yet (approve its new capabilities)',
  not_allowed: 'The orca-office plugin does not allow that',
};
const say = (e: string | undefined) => (e && ERRORS[e]) || `Orca said no${e ? ` (${e})` : ''}`;

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
    toast(say(msg.error), 'warn');
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

/** A chat agent (no terminal): what it said last, and the way to it in Orca. */
export function openChatAgent(net: Net, w: WorkerInfo) {
  const said = w.task?.summary ?? '';
  const open = h('button.btn.primary', { type: 'button', onclick: () => (openInOrca(net, { workerId: w.id }), modal.close()) }, '↗ Open in Orca');
  const el = h(
    'div.modal.orca-chat',
    { role: 'dialog', 'aria-label': `${w.name}, chat agent` },
    h('header', {}, h('span.dot', { style: `background:${w.color}` }), h('h2', {}, `💬 ${w.name}`), h('span.pill', { class: w.status }, STATUS_LABEL[w.status] ?? w.status)),
    h('div.body', {}, h('p.orca-note', {}, `A chat in Orca on ${w.task?.name ?? 'its worktree'}: it has no terminal to open here.`), said ? h('blockquote.orca-said', {}, said) : h('p.orca-note', {}, 'Nothing said yet.')),
    h('footer', {}, w.orca?.remote ? h('span.grow', {}, 'Runs on another host') : h('span.grow', {}), w.orca?.remote ? null : open),
  );
  const modal = openModal(el, { doing: `💬 with ${w.name}` });
  if (!w.orca?.remote) open.focus();
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
  const agent = h('select', { 'aria-label': 'Agent' }, ...ORCA_AGENTS.map((a) => h('option', { value: a }, a))) as HTMLSelectElement;
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
