import './services.css';
import type { ServiceInfo } from '@orca-office/shared/office/protocol';
import { store } from '../state';
import { h, openModal, timeAgo } from './dom';

/**
 * The services board (roadmap B7): the dev servers running in this floor's worktrees, as Orca's
 * `orca ports` finds them. The office runs on the same Mac as Orca, so Open is just localhost.
 */
export function serviceUrl(svc: Pick<ServiceInfo, 'port' | 'url'>): string {
  return svc.url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(svc.url) ? svc.url : `http://localhost:${svc.port}`;
}

/** Who it belongs to, for the row's dot and its second line. */
export function serviceOwner(svc: ServiceInfo): { color: string; where: string } {
  const w = store.workers.get(svc.workerId);
  const where = [svc.worktree ?? w?.worktree?.branch ?? '', svc.branch && svc.branch !== svc.worktree ? `🌿 ${svc.branch}` : ''].filter(Boolean).join(' · ');
  return { color: w?.color ?? '#8d99ae', where };
}

export function openServices() {
  const body = h('div.body.services');
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const el = h(
    'div.modal',
    { role: 'dialog', 'aria-label': 'Services', style: 'width:min(720px,100%)' },
    h('header', {}, h('h2', {}, '🌐 Services'), close),
    body,
    h('footer', {}, h('span.grow.note', {}, 'From Orca’s port scan, every ~10 s. Only servers in this floor’s worktrees.')),
  );

  const render = () => {
    const items = store.services.items;
    body.replaceChildren();
    if (!items.length) {
      body.append(
        h(
          'div.svc-empty',
          {},
          h('p', {}, 'No dev servers running on this floor.'),
          h('p.note', {}, 'Start one in a worktree — ', h('code', {}, 'npm run dev'), ', a preview build — and it shows up here and on its desk within ~10 s.'),
        ),
      );
      return;
    }
    const list = h('ul.svc-list');
    for (const svc of items) {
      const { color, where } = serviceOwner(svc);
      const url = serviceUrl(svc);
      const open = h('a.btn', { href: url, target: '_blank', rel: 'noopener', title: `Open ${url} in a new tab` }, 'Open ↗');
      list.append(
        h(
          'li',
          {},
          h('span.dot', { style: `background:${color}` }),
          h(
            'div.svc-main',
            {},
            h('div.svc-title', {}, svc.title || svc.command),
            h('div.svc-meta', {}, [where, svc.title ? svc.command : '', `started ${timeAgo(svc.since)}`].filter(Boolean).join(' · ')),
          ),
          h('span.svc-port', {}, `:${svc.port}`),
          open,
        ),
      );
    }
    body.append(list);
  };

  const unsubs = [store.on('services', render), store.on('workers', render)];
  // Keeps "up 5m" fresh.
  const tick = setInterval(render, 30_000);
  const modal = openModal(el, {
    doing: '🌐 at the services board',
    onClose: () => {
      unsubs.forEach((u) => u());
      clearInterval(tick);
    },
  });
  close.addEventListener('click', () => modal.close());
  render();
}
