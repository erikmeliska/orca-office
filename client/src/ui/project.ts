import './project.css';
import type { OrcaProject, ServerMsg } from '@orca-office/shared/office/protocol';
import type { Net } from '../net';
import { store } from '../state';
import { $, h, openModal, type Modal } from './dom';

/**
 * A project room's board (#29, #30, design #10, #27): the Run's objective, who coordinates it, its
 * tasks and the decision gates waiting for you, each with "Open in Orca". Read-only: decisions are
 * made in Orca, never from here. A button on the HUD opens it while you are in a project room; the
 * room's wall boards do too.
 */
let current: { floor: string; project: OrcaProject } | null = null;
let net: Net | null = null;
let pill: HTMLButtonElement | null = null;
let open: { modal: Modal; render: () => void } | null = null;

const STATUS: Record<OrcaProject['tasks'][number]['status'], string> = { pending: '⏳ pending', ready: '🟢 ready', dispatched: '🛠️ working', in_progress: '🛠️ working', blocked: '⛔ blocked', completed: '✅ done', failed: '❌ failed' };

export function installProjectBoard(n: Net) {
  net = n;
  pill = h('button.btn.project-pill.hidden', { type: 'button', title: 'The project board: objective, tasks and decisions waiting for you' }) as HTMLButtonElement;
  pill.addEventListener('click', () => openProjectBoard());
  $('hud').append(pill);
  store.on('floor', paintPill);
}

/** The board of the room you're in, if you're in one. */
export function currentProject(): OrcaProject | null {
  return current && current.floor === store.floor ? current.project : null;
}

/** Main feeds server messages through here. */
export function routeProjectMessage(msg: ServerMsg) {
  if (msg.t !== 'orca.project') return;
  current = msg.project ? { floor: msg.floor, project: msg.project } : null;
  paintPill();
  if (open) {
    if (currentProject()) open.render();
    else open.modal.close();
  }
}

function paintPill() {
  const p = currentProject();
  if (!pill) return;
  pill.classList.toggle('hidden', !p);
  if (!p) return;
  const n = p.gates.length;
  pill.replaceChildren(h('span', {}, '🏗️ Project board'), n ? h('span.gates', {}, `⚖️ ${n}`) : '');
  pill.classList.toggle('waiting', n > 0);
}

export function openProjectBoard() {
  if (open || !currentProject()) return;
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const title = h('h2');
  const body = h('div.body');
  const el = h('div.modal.project-board', { role: 'dialog', 'aria-label': 'Project board' }, h('header', {}, title, close), body, h('footer', {}, h('span.grow', {}, 'Read-only · decide in Orca')));
  const render = () => {
    const p = currentProject();
    if (!p) return;
    title.textContent = `🏗️ ${p.objective ?? 'Project'}`;
    const head = p.coordinator ? `👑 ${p.coordinator.name}${p.coordinator.bot ? ' (bot)' : ''} coordinates` : '👑 Orca doesn’t say who coordinates this Run';
    const sections: HTMLElement[] = [h('p.pb-head', {}, p.source === 'lineage' ? `🌳 A worktree and the ones it started · ${head.replace(' coordinates', ' at the head')}` : head)];
    if (p.gates.length) {
      sections.push(
        h('h3.pb-gates-title', {}, `⚖️ Waiting for your decision (${p.gates.length})`),
        ...p.gates.map((g) => {
          const go = h('button.btn.primary', { type: 'button', disabled: !g.seat, title: g.seat ? 'Open the desk this decision blocks in Orca' : 'No desk to open: decide in Orca' }, '↗ Open in Orca') as HTMLButtonElement;
          go.addEventListener('click', () => g.seat && net?.send({ t: 'orca.open', deskId: g.seat }));
          return h('div.pb-gate', {}, h('div.pb-q', {}, g.question ?? 'A decision'), g.options.length ? h('div.pb-opts', { title: 'The answers Orca offers: decide in Orca' }, 'Options: ', g.options.join(' · ')) : '', go);
        }),
      );
    }
    if (p.tasks.length) {
      const done = p.tasks.filter((t) => t.status === 'completed').length;
      sections.push(h('h3', {}, `📋 Tasks · ${done} of ${p.tasks.length} done`), h('ul.pb-tasks', {}, ...p.tasks.map((t) => h('li', { class: `st-${t.status}` }, h('span.pb-st', {}, STATUS[t.status]), h('span.pb-t', {}, t.title ?? t.id)))));
    }
    if (p.members.length) sections.push(h('h3', {}, '🌿 Worktrees'), h('ul.pb-tasks', {}, ...p.members.map((m) => h('li', {}, h('span.pb-t', {}, m)))));
    body.replaceChildren(...sections);
  };
  const modal = openModal(el, { doing: '🏗️ at the project board', onClose: () => (open = null) });
  close.addEventListener('click', () => modal.close());
  open = { modal, render };
  render();
}
