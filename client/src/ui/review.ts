import './review.css';
import { CI_LABEL, reviewQueue, type ReviewItem } from '../review-queue';
import { store } from '../state';
import { span } from '@orca-office/shared/office/stuck';
import { h, openModal, type Modal } from './dom';
import { currentForge, onForge } from './forge';
import { deskLinks, httpsUrl } from './links';

/**
 * The review queue (M7, roadmap B4): this floor's agents that are done and wait on a review of their
 * pull/merge request, longest waiting first, each with its checks, its size and how long it has
 * waited. A click opens it on its forge (https only, a new tab). The checks and sizes come with the
 * repo board (`gh pr list`, kept 3 min; no call per pull request).
 */
export function reviewItems(): ReviewItem[] {
  return reviewQueue(store.workers.values(), deskLinks, currentForge()?.pulls ?? []);
}

let open: { modal: Modal; render: () => void } | null = null;
onForge(() => open?.render());
store.on('workers', () => open?.render());

export function openReviewQueue(goTo: (workerId: string) => void) {
  if (open) return;
  const list = h('ul.review-list');
  const render = () => {
    const items = reviewItems();
    const now = Date.now();
    list.replaceChildren(
      ...(items.length
        ? items.map((r) => {
            const url = r.url ? httpsUrl(r.url) : null;
            const size = r.additions !== undefined || r.deletions !== undefined ? h('span.review-size', {}, h('span.add', {}, `+${r.additions ?? 0}`), ' ', h('span.del', {}, `−${r.deletions ?? 0}`)) : null;
            return h(
              'li.review-item',
              { class: r.ci ?? '' },
              h('div.review-head', {}, h('strong', {}, `🔀 ${r.ref}`), h('span.review-who', {}, r.name), h('span.review-when', {}, `waits ${span(now - r.since)}`)),
              r.title ? h('p.review-title', {}, r.title) : null,
              h('div.review-meta', {}, h('span.review-ci', { class: r.ci ?? 'unknown' }, r.ci ? CI_LABEL[r.ci] : '· checks unknown'), size),
              h(
                'div.review-acts',
                {},
                url ? h('a.btn.primary', { href: url, target: '_blank', rel: 'noopener noreferrer' }, '↗ Open the PR') : null,
                h('button.btn', { type: 'button', onclick: () => (modal.close(), goTo(r.workerId)) }, 'Go to its desk'),
              ),
            );
          })
        : [h('li.review-empty', {}, 'Nobody on this floor is waiting on a review. A done agent whose worktree has a pull request in Orca shows up here.')]),
    );
  };
  const el = h('div.modal.review-queue', { role: 'dialog', 'aria-label': 'Review queue' }, h('header', {}, h('h2', {}, '👀 Review queue')), list);
  const modal = openModal(el, { doing: 'looking at the review queue', onClose: () => (open = null) });
  open = { modal, render };
  render();
}
