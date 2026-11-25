/**
 * The Command Center (M7, roadmap B3): G puts the whole building on one screen, in columns: Needs you
 * / Working / Stuck? / Done / Ended. A card is a worktree's agent: its name, branch, floor, Orca's
 * Kanban status (B10), how long it's been so and its last bubble. A click takes you to its desk,
 * Enter (or the card's ⏎) there with its terminal open, and one that asks can be answered on the card
 * (B1). The Kanban chips filter it.
 */
import './command.css';
import { kanbanStyle } from '@orca-office/shared/office/kanban';
import { span } from '@orca-office/shared/office/stuck';
import type { OrcaAnswer, OrcaRosterFloor, OrcaSteer } from '@orca-office/shared/office/protocol/orca';
import { COLUMNS, commandCards, kanbanStatuses, type Card } from '../../command-center';
import type { Ctx } from '../../core/context';
import type { Parts } from '../../core/parts';
import { store } from '../../state';
import { h, openModal, toast, type Modal } from '../../ui/dom';
import { isOrca } from '../../ui/orca';

export function installCommandCenter(ctx: Ctx, parts: Pick<Parts, 'waiting'>) {
  const { net } = ctx;
  let modal: Modal | null = null;
  let filter = '';
  let board: HTMLElement | null = null;
  let chips: HTMLElement | null = null;
  /** Drafts of the answers typed on cards, by figure. */
  const drafts = new Map<string, string>();

  /** The building as the roster has it; the stub's (no roster): this floor's workers. */
  function roster(): OrcaRosterFloor[] {
    if (store.roster.length) return store.roster;
    const name = store.floors.find((f) => f.id === store.floor)?.name ?? '';
    return store.floor ? [{ floor: store.floor, name, workers: [...store.workers.values()].map((w) => ({ id: w.id, name: w.name, status: w.status, deskId: w.deskId, ...(w.task?.summary ? { summary: w.task.summary } : {}), since: w.waitingSince ?? w.workingSince, ...(w.status === 'done' && !w.acked ? { unread: true } : {}) })) }] : [];
  }

  function close() {
    modal?.close();
  }

  const go = (c: Card) => {
    close();
    if (c.kind === 'gate') return parts.waiting.goToKey(c.key);
    if (c.workerId && c.deskId) parts.waiting.goToFigure(c.floor, c.workerId, c.deskId, c.name);
  };
  const enter = (c: Card) => {
    close();
    if (c.kind === 'gate') return parts.waiting.goToKey(c.key);
    if (c.workerId && c.deskId) parts.waiting.openFigure(c.floor, c.workerId, c.deskId, c.name);
  };
  const answer = (c: Card, choice: OrcaAnswer) => {
    if (c.workerId && c.since !== undefined) net.send({ t: 'orca.answer', workerId: c.workerId, choice, since: c.since });
  };

  function card(c: Card): HTMLElement {
    const now = Date.now();
    const k = c.kanban ? kanbanStyle(c.kanban) : null;
    const where = [c.floor !== store.floor ? `🏢 ${c.floorName}` : '🏢 here', c.branch && c.branch !== c.name ? `🌿 ${c.branch}` : ''].filter(Boolean).join(' · ');
    const when = c.stuckWhy ?? (c.since ? span(now - c.since) : '');
    const btn = (label: string, title: string, fn: () => void, cls = '') =>
      h(`button.cc-btn${cls}`, { type: 'button', title, onclick: (e: Event) => (e.stopPropagation(), fn()) }, label);
    const acts: HTMLElement[] = [];
    if (c.column === 'needs' && c.terminal && c.asks === 'permission' && isOrca()) {
      acts.push(btn('✓ Yes', 'Allow it this once', () => answer(c, 'yes'), '.yes'), btn('✓✓ Always', "Allow it and don't ask again", () => answer(c, 'always')), btn('✕ No', 'Say no (Esc)', () => answer(c, 'no'), '.no'));
    } else if (c.column === 'needs' && c.terminal && isOrca()) {
      const input = h('input.cc-input', { type: 'text', placeholder: 'Answer…', 'aria-label': `Answer ${c.name}`, value: drafts.get(c.key) ?? '' });
      const send = () => {
        const text = input.value.trim();
        if (!text || !c.workerId) return;
        net.send({ t: 'worker.prompt', workerId: c.workerId, prompt: text });
        drafts.delete(c.key);
        input.value = '';
        toast('✓ Sent');
      };
      input.addEventListener('input', () => drafts.set(c.key, input.value));
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          send();
        }
      });
      acts.push(input, btn('Send', 'Type it into its terminal and press Enter', send, '.yes'));
    }
    // Steering (M7 B13), a click each: interrupt or a summary while it works, continue once it's done.
    if (c.terminal && c.workerId && isOrca()) {
      const steer = (s: OrcaSteer) => net.send({ t: 'orca.steer', workerId: c.workerId!, steer: s });
      if (c.column === 'working' || c.column === 'stuck') acts.push(btn('⏸', 'Interrupt it (Esc)', () => steer('interrupt')), btn('📝', 'Ask it to pause and summarize where it is', () => steer('summarize')));
      if (c.column === 'done' || c.column === 'ended') acts.push(btn('▶', 'Tell it to continue', () => steer('continue')), btn('📝', 'Ask it to summarize where it is', () => steer('summarize')));
    }
    if (c.kind === 'agent' && c.workerId && isOrca() && !c.bot) acts.push(btn('↗ Orca', 'Open it in Orca', () => net.send({ t: 'orca.open', workerId: c.workerId! })));
    acts.push(btn('⏎', c.kind === 'gate' ? 'Go to the desk the decision is about' : c.chat ? 'Go there and read its conversation' : 'Go there with its terminal open', () => enter(c)));
    const el = h(
      'li.cc-card',
      { class: c.column, tabindex: '0', role: 'button', title: c.kind === 'gate' ? 'Go to the decision' : `Go to ${c.name}'s desk (Enter: with its terminal open)`, onclick: () => go(c) },
      k ? h('span.cc-kanban', { style: `background:${k.color};color:${k.ink}` }, k.label) : null,
      h('div.cc-head', {}, h('strong', {}, `${c.bot ? '🤖 ' : c.chat ? '💬 ' : ''}${c.name}`), when ? h('span.cc-when', {}, when) : null),
      where ? h('div.cc-where', {}, where) : null,
      c.text ? h('p.cc-text', {}, c.text) : null,
      acts.length ? h('div.cc-acts', {}, ...acts) : null,
    );
    el.dataset.key = c.key;
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        enter(c);
      }
    });
    return el;
  }

  function paint() {
    if (!board || !chips) return;
    // Not under someone's fingers: a card being typed into waits for the next change.
    if (board.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement) return;
    const r = roster();
    const statuses = kanbanStatuses(r);
    if (filter && !statuses.includes(filter)) filter = '';
    chips.replaceChildren(
      ...(statuses.length
        ? [
            h('span.cc-chips-label', {}, 'Orca status'),
            h('button.cc-chip', { type: 'button', class: filter === '' ? 'on' : '', 'aria-pressed': String(filter === ''), onclick: () => ((filter = ''), paint()) }, 'All'),
            ...statuses.map((s) => {
              const k = kanbanStyle(s);
              return h('button.cc-chip', { type: 'button', class: filter === s ? 'on' : '', 'aria-pressed': String(filter === s), style: `--chip:${k.color}`, onclick: () => ((filter = s), paint()) }, k.label);
            }),
          ]
        : []),
    );
    const cols = commandCards(r, store.waitingAll, ctx.settings.stuck, Date.now(), filter);
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
    board.replaceChildren(
      ...COLUMNS.map(({ id, title, empty }) =>
        h('section.cc-col', { class: id, 'aria-label': title }, h('h3', {}, title, h('span.cc-count', {}, String(cols[id].length))), cols[id].length ? h('ul', {}, ...cols[id].map(card)) : h('p.cc-empty', {}, empty)),
      ),
    );
    if (focused) board.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
  }

  function open() {
    if (modal) return;
    chips = h('div.cc-chips');
    board = h('div.cc-board');
    const el = h('div.modal.command-center', { role: 'dialog', 'aria-label': 'Command Center' }, h('header.cc-top', {}, h('h2', {}, '🛰️ Command Center'), h('span.cc-hint', {}, 'Click: go to the desk · Enter: open its terminal · G or Esc: close')), chips, board);
    modal = openModal(el, { doing: 'in the Command Center', onClose: () => ((modal = null), (board = null), (chips = null)) });
    paint();
    board.querySelector<HTMLElement>('.cc-card')?.focus();
  }

  const toggle = () => (modal ? close() : open());
  for (const t of ['roster', 'waitingAll', 'workers'] as const) store.on(t, () => modal && paint());
  // How long each has been so moves on, and someone can get stuck with nothing happening.
  setInterval(() => modal && paint(), 20_000);

  ctx.keys.bind({ code: 'KeyG', run: () => toggle() });
  // G closes it too (keys are the window's while it's open).
  window.addEventListener('keydown', (e) => {
    if (modal && e.code === 'KeyG' && !(e.target instanceof HTMLInputElement) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      close();
    }
  });
  return { open, toggle };
}
