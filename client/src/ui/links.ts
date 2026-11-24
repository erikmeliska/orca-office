import './links.css';
import type { OrcaLink, ServerMsg } from '@orca-office/shared/office/protocol';
import { store } from '../state';
import { h, openModal } from './dom';

/**
 * What Orca links to the desks (#32): pull/merge requests, issues, Linear and Jira items from
 * `orca worktree list`. The office never asks a forge: each link opens where it lives, in a new tab.
 */
let floor: string | null = null;
let desks: Record<string, OrcaLink[]> = {};

/** Main feeds server messages through here: keeps the floor's desk links. */
export function routeLinksMessage(msg: ServerMsg) {
  if (msg.t !== 'orca.links') return;
  floor = msg.floor;
  desks = msg.desks ?? {};
}

/** The links on a desk of the floor you are on. */
export function deskLinks(deskId: string): OrcaLink[] {
  return floor === store.floor ? (desks[deskId] ?? []) : [];
}

/** Every link on the floor you are on, once each. */
export function floorLinks(): OrcaLink[] {
  if (floor !== store.floor) return [];
  const seen = new Set<string>();
  return Object.values(desks)
    .flat()
    .filter((l) => {
      const k = `${l.provider}|${l.kind}|${l.ref}|${l.url ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

const ICON: Record<OrcaLink['kind'], string> = { pr: '🔀', mr: '🔀', issue: '📌', item: '🔗' };
const NAME: Record<OrcaLink['provider'], string> = { github: 'GitHub', gitlab: 'GitLab', linear: 'Linear', jira: 'Jira', bitbucket: 'Bitbucket', azure: 'Azure DevOps', gitea: 'Gitea', other: '' };
const KIND: Record<OrcaLink['kind'], string> = { pr: 'pull request', mr: 'merge request', issue: 'issue', item: 'item' };

/** Opens a link in a new tab (https only, without the office as its opener). */
export function openLink(url: string | undefined): boolean {
  if (!url || !/^https:\/\//.test(url)) return false;
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

function row(l: OrcaLink): HTMLElement {
  const what = [NAME[l.provider], KIND[l.kind]].filter(Boolean).join(' ');
  const body = [h('span.link-ref', {}, `${ICON[l.kind]} ${l.ref}`), h('span.link-title', {}, l.title ?? what), h('span.link-where', {}, l.url ? `${what} ↗` : `${what} · no address from Orca`)];
  if (!l.url) return h('div.link-row.off', { title: 'Orca linked it without an address' }, ...body);
  return h('a.link-row', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, ...body);
}

/** The board of a desk (or of the whole floor): its links, each opening in the browser. */
export function openLinks(title: string, links: OrcaLink[]) {
  const close = h('button.btn.close', { type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '✕');
  const el = h(
    'div.modal.orca-links',
    { role: 'dialog', 'aria-label': title },
    h('header', {}, h('h2', {}, title), close),
    h('div.body', {}, links.length ? h('div.link-list', {}, ...links.map(row)) : h('p.empty', {}, 'Orca links nothing here yet. A PR or issue linked to the worktree in Orca shows up here.')),
    h('footer', {}, h('span.grow', {}, 'Links come from Orca · they open in your browser')),
  );
  const modal = openModal(el, { doing: '🔗 reading the links' });
  close.addEventListener('click', () => modal.close());
}
