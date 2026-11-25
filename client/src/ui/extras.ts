import './extras.css';
import type { OrcaAutomation, OrcaCleanupRow, OrcaSearchHit, ServerMsg } from '@orca-office/shared/office/protocol';
import { span } from '@orca-office/shared/office/stuck';
import type { Net } from '../net';
import { h, openModal, type Modal } from './dom';

/**
 * Orca's other corners in the office (M7, roadmap B8, B9, B11): the sessions' full-text search for
 * ⌘K, the automations (next run, last result, Run now) and what the cleanup rules would remove. The
 * bridge reads them on demand (bridge/src/live/extras.ts); text only ever as its bubbles, kept nowhere.
 */

// ---- B8: search -----------------------------------------------------------------------------------

const waiting = new Map<string, (hits: OrcaSearchHit[]) => void>();

/** Asks the bridge to search the sessions; resolves with the hits (none for under 3 characters). */
export function searchSessions(net: Net, query: string): Promise<OrcaSearchHit[]> {
  const q = query.trim();
  if (q.length < 3) return Promise.resolve([]);
  const reqId = crypto.randomUUID().slice(0, 18);
  return new Promise((resolve) => {
    waiting.set(reqId, resolve);
    // A bridge that never answers (offline): nothing, after a while.
    setTimeout(() => waiting.get(reqId) && (waiting.delete(reqId), resolve([])), 10_000);
    net.send({ t: 'orca.search', reqId, query: q.slice(0, 200) });
  });
}

export function ago(at: number | undefined): string {
  return at ? `${span(Date.now() - at)} ago` : '';
}

// ---- B9: automations ------------------------------------------------------------------------------

let autoPanel: { modal: Modal; show(items: OrcaAutomation[]): void } | null = null;

const STATUS: Record<string, string> = { completed: '✅ done', succeeded: '✅ done', failed: '❌ failed', error: '❌ failed', skipped_unavailable: '⏭️ skipped', skipped: '⏭️ skipped', queued: '⏳ queued', dispatching: '⏳ starting', running: '⚙️ running' };

/** When it runs next, as a wall clock would say it: "today 08:00", "Fri 16:00". */
export function nextLabel(at: number | null, now = Date.now()): string {
  if (!at) return 'not scheduled';
  const d = new Date(at);
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  return days <= 0 ? `today ${hm}` : days === 1 ? `tomorrow ${hm}` : `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}`;
}

export function openAutomations(net: Net) {
  if (autoPanel) return;
  const list = h('ul.ex-list', {}, h('li.ex-empty', {}, 'Reading Orca’s automations…'));
  let asking: string | null = null;
  let items: OrcaAutomation[] = [];
  const render = () => {
    list.replaceChildren(
      ...(items.length
        ? items.map((a) => {
            const run =
              asking === a.id
                ? h(
                    'div.ex-confirm',
                    {},
                    h('span', {}, 'Run it now, outside its schedule?'),
                    h('button.btn.primary', { type: 'button', onclick: () => ((asking = null), net.send({ t: 'orca.automations.run', id: a.id, confirm: true }), setTimeout(() => net.send({ t: 'orca.automations' }), 1500), render()) }, '▶ Yes, run it'),
                    h('button.btn', { type: 'button', onclick: () => ((asking = null), render()) }, 'Cancel'),
                  )
                : h('button.btn', { type: 'button', title: 'Start it now in Orca (it asks you first)', onclick: () => ((asking = a.id), render()) }, '▶ Run now');
            return h(
              'li.ex-item',
              { class: a.enabled ? '' : 'off' },
              h('div.ex-clock', { 'aria-hidden': 'true' }, '🕒'),
              h(
                'div.ex-body',
                {},
                h('div.ex-head', {}, h('strong', {}, `${a.bot ? '🤖 ' : ''}${a.name}`), h('span.ex-next', {}, a.enabled ? `next ${nextLabel(a.nextRunAt)}` : 'paused')),
                h('div.ex-meta', {}, h('code', {}, a.schedule || '—'), a.last ? h('span', {}, `last: ${STATUS[a.last.status] ?? a.last.status} ${ago(a.last.at)}${a.last.error ? ` (${a.last.error})` : ''}`) : h('span', {}, 'never ran')),
                run,
              ),
            );
          })
        : [h('li.ex-empty', {}, 'Orca has no automations.')]),
    );
  };
  const el = h('div.modal.ex-panel', { role: 'dialog', 'aria-label': 'Automations' }, h('header', {}, h('h2', {}, '🕒 Automations')), list, h('p.ex-note', {}, 'Orca runs these on their schedule. Run now starts one at once, after you say yes; the office never runs one by itself.'));
  const modal = openModal(el, { doing: 'looking at the automations', onClose: () => (autoPanel = null) });
  autoPanel = { modal, show: (x) => ((items = x), render()) };
  net.send({ t: 'orca.automations' });
}

// ---- B11: cleanup ---------------------------------------------------------------------------------

let cleanPanel: { modal: Modal; show(m: Extract<ServerMsg, { t: 'orca.cleanup' }>): void } | null = null;

const CAUSE: Record<string, string> = { merged: 'its branch is merged', inactive: 'nothing happened in it for a long time', 'not-removable': 'the repository’s own checkout', 'rules-off': 'cleanup is off for its project', 'has-agent': 'an agent works in it' };
const cause = (c: string) => CAUSE[c] ?? c.replace(/[-_]+/g, ' ');

export function openCleanup(net: Net) {
  if (cleanPanel) return;
  const body = h('div.ex-clean', {}, h('p.ex-empty', {}, 'Asking Orca what its cleanup rules would remove…'));
  /** 0: just looking; 1: said "clean up" once; 2: asked to type it. */
  let step = 0;
  let last: Extract<ServerMsg, { t: 'orca.cleanup' }> | null = null;
  const render = () => {
    if (!last) return;
    const n = last.remove.length;
    const keep = Object.entries(last.keep).sort((a, b) => b[1] - a[1]);
    const rows = n ? h('ul.ex-list', {}, ...last.remove.map((r: OrcaCleanupRow) => h('li.ex-item.remove', {}, h('div.ex-clock', { 'aria-hidden': 'true' }, '🗑️'), h('div.ex-body', {}, h('div.ex-head', {}, h('strong', {}, r.name), h('span.ex-next', {}, r.repo)), h('div.ex-meta', {}, r.branch ? h('code', {}, r.branch) : null, h('span', {}, `would go: ${cause(r.cause)}`)))))) : h('p.ex-empty', {}, '✨ Nothing to clean up: the rules would remove nothing now.');
    const kept = keep.length ? h('p.ex-note', {}, `Staying: ${keep.map(([c, k]) => `${k} because ${cause(c)}`).join(' · ')}.`) : null;
    let act: HTMLElement | null = null;
    if (n && step === 0) act = h('button.btn.danger', { type: 'button', onclick: () => ((step = 1), render()) }, `🧹 Clean up ${n}…`);
    else if (n && step === 1)
      act = h(
        'div.ex-confirm',
        {},
        h('span', {}, `Orca removes these ${n} worktree${n === 1 ? '' : 's'} by its own rules (it checks each again first). This can’t be undone from the office.`),
        h('button.btn.danger', { type: 'button', onclick: () => ((step = 2), render()) }, 'I understand, continue'),
        h('button.btn', { type: 'button', onclick: () => ((step = 0), render()) }, 'Cancel'),
      );
    else if (n && step === 2) {
      const input = h('input.ex-type', { type: 'text', placeholder: 'type remove', 'aria-label': 'Type remove to confirm', autocomplete: 'off' });
      const go = h('button.btn.danger', { type: 'button', disabled: true, onclick: () => (net.send({ t: 'orca.cleanup.run', confirm: 'remove', expect: n }), (step = 0), (body.textContent = '🧹 Cleaning up…'), setTimeout(() => net.send({ t: 'orca.cleanup.preview' }), 2500)) }, `Remove ${n} now`);
      input.addEventListener('input', () => (go.disabled = input.value.trim().toLowerCase() !== 'remove'));
      input.addEventListener('keydown', (e) => e.stopPropagation());
      act = h('div.ex-confirm', {}, h('span', {}, 'Type “remove” to confirm:'), input, go, h('button.btn', { type: 'button', onclick: () => ((step = 0), render()) }, 'Cancel'));
      setTimeout(() => input.focus(), 0);
    }
    body.replaceChildren(rows, kept ?? '', act ?? '');
  };
  const el = h('div.modal.ex-panel', { role: 'dialog', 'aria-label': 'Clean up' }, h('header', {}, h('h2', {}, '🗑️ Clean up')), body, h('p.ex-note', {}, 'What Orca’s workspace cleanup rules (set in Orca’s settings) would remove right now, and why. Looking removes nothing.'));
  const modal = openModal(el, { doing: 'looking at what to clean up', onClose: () => (cleanPanel = null) });
  cleanPanel = { modal, show: (m) => ((last = m), render()) };
  net.send({ t: 'orca.cleanup.preview' });
}

/** Every server message passes here; picks out these. */
export function routeExtrasMessage(msg: ServerMsg) {
  if (msg.t === 'orca.search') {
    waiting.get(msg.reqId)?.(msg.hits);
    waiting.delete(msg.reqId);
  } else if (msg.t === 'orca.automations') autoPanel?.show(msg.items);
  else if (msg.t === 'orca.cleanup') cleanPanel?.show(msg);
}
