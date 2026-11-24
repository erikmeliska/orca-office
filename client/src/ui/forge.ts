import './links.css';
import type { GhIssue, GhState, OrcaForgeBoard, OrcaForgeItem, ServerMsg } from '@orca-office/shared/office/protocol';
import { store } from '../state';
import { h, openModal, type Modal } from './dom';
import { httpsUrl } from './links';

/**
 * The floor's repo-wide board (v2, #38, design #17): the repository's open issues, pull/merge
 * requests and the queue (what no worktree works on yet), read by the bridge through `gh` / `glab`.
 * Read only: each item opens on its forge, in a new tab (https only).
 */
let current: { floor: string; board: OrcaForgeBoard | null } | null = null;
let open: { modal: Modal; render: () => void } | null = null;
const listeners = new Set<() => void>();

/** Main feeds server messages through here. */
export function routeForgeMessage(msg: ServerMsg) {
  if (msg.t !== 'orca.forge') return;
  current = { floor: msg.floor, board: msg.board };
  for (const fn of listeners) fn();
  open?.render();
}

/** The board of the floor you are on, if it has one. */
export function currentForge(): OrcaForgeBoard | null {
  return current && current.floor === store.floor ? current.board : null;
}

/** Called whenever the board changes (the queue's wall redraws). */
export function onForge(fn: () => void) {
  listeners.add(fn);
}

/** The queue as notes for the queue's wall (BoardTexture): issues first, then pull/merge requests. */
export function queueState(): GhState<GhIssue> {
  const b = currentForge();
  const items = (b?.queue ?? []).map(
    (i): GhIssue => ({ number: i.number, url: i.url ?? '', title: `${i.kind === 'issue' ? '📌' : '🔀'} ${i.title}`, state: 'OPEN', author: '', labels: [], assignees: [], createdAt: '', updatedAt: '', body: '', comments: 0 }),
  );
  if (!b) return { items, fetchedAt: 0, loading: false, error: 'No repo board on this floor' };
  return { items, fetchedAt: b.fetchedAt, loading: b.status === 'loading', ...(b.note && b.status !== 'loading' ? { error: b.note } : {}) };
}

export type ForgeWall = 'issues' | 'pulls' | 'queue';

const TITLES: Record<ForgeWall, string> = { issues: '📌 Open issues', pulls: '🔀 Open pull requests', queue: '📋 Queue · no worktree yet' };
const PROVIDER: Record<NonNullable<OrcaForgeBoard['provider']>, string> = { github: 'GitHub', gitlab: 'GitLab' };

function itemRow(i: OrcaForgeItem): HTMLElement {
  const what = `${i.kind === 'issue' ? 'issue' : i.kind === 'mr' ? 'merge request' : 'pull request'}${i.draft ? ' · draft' : ''}${i.worktree ? ' · 🪑 has a worktree' : ''}`;
  const body = [h('span.link-ref', {}, `${i.kind === 'issue' ? '📌' : '🔀'} ${i.ref}`), h('span.link-title', {}, i.title), h('span.link-where', {}, i.url ? `${what} ↗` : what)];
  const href = httpsUrl(i.url);
  if (!href) return h('div.link-row.off', {}, ...body);
  return h('a.link-row', { href, target: '_blank', rel: 'noopener noreferrer' }, ...body);
}

/** Whether the floor has a forge board to open (else the walls fall back to Orca's links). */
export function hasForge(): boolean {
  return !!currentForge();
}

/** One of the board's lists in a modal: issues, pull/merge requests, or the queue. */
export function openForgeBoard(wall: ForgeWall) {
  if (open) return;
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const title = h('h2', {}, TITLES[wall]);
  const body = h('div.body');
  const foot = h('span.grow');
  const el = h('div.modal.orca-links.forge-board', { role: 'dialog', 'aria-label': TITLES[wall] }, h('header', {}, title, close), body, h('footer', {}, foot));
  const render = () => {
    const b = currentForge();
    if (!b) return void modal.close();
    const list = wall === 'issues' ? b.issues : wall === 'pulls' ? b.pulls : b.queue;
    title.textContent = wall === 'pulls' && b.provider === 'gitlab' ? '🔀 Open merge requests' : TITLES[wall];
    const note = b.note ? h('p.forge-note', {}, b.note) : '';
    const empty = b.status === 'loading' ? 'Reading the board…' : wall === 'queue' ? 'Nothing waiting: every open item has a worktree. 🎉' : 'Nothing open here. 🎉';
    body.replaceChildren(note, list.length ? h('div.link-list', {}, ...list.map(itemRow)) : b.note ? '' : h('p.empty', {}, empty));
    const where = b.provider && b.repo ? `${PROVIDER[b.provider]} · ${b.repo}` : 'No forge';
    foot.textContent = `${where}${b.fetchedAt ? ` · read ${new Date(b.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''} · opens in your browser`;
  };
  const modal = openModal(el, { doing: '📋 reading the repo board', onClose: () => (open = null) });
  open = { modal, render };
  close.addEventListener('click', () => modal.close());
  render();
}
