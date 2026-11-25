import './hud.css';
import { h, openModal } from './dom';
import { funOn } from '../fun';
import { FUN_ROWS, HELP_ROWS, SUPERVISE_ROWS } from './help';

export function openHelp() {
  const close = h('button.btn.close', { 'aria-label': 'Close' }, '✕');
  const el = h(
    'div.modal',
    { role: 'dialog', 'aria-label': 'Controls' },
    h('header', {}, h('h2', {}, '🎮 Controls'), close),
    h(
      'div.body',
      {},
      h('div.help-grid', {}, ...SUPERVISE_ROWS.flatMap(([k, v]) => [h('span.key', {}, k), h('span', {}, v)])),
      h('details.help-more', {}, h('summary', {}, 'All controls'), h('div.help-grid', {}, ...HELP_ROWS.filter(([k]) => funOn() || !FUN_ROWS.has(k)).flatMap(([k, v]) => [h('span.key', {}, k), h('span', {}, v)]))),
    ),
  );
  const modal = openModal(el);
  close.addEventListener('click', () => modal.close());
}

const HINTED = 'orca-office.firstHint';

/**
 * The first time the office opens (M6 A10): one line on what to press, until it's closed or N is
 * pressed. Remembered in this browser only.
 */
export function firstRunHint(hud: HTMLElement) {
  // Keys are no use on a touch screen.
  if (window.matchMedia?.('(pointer: coarse)').matches) return;
  try {
    if (localStorage.getItem(HINTED)) return;
  } catch {
    // No storage (a private window): show it each time, it's one line.
  }
  const done = () => {
    el.remove();
    window.removeEventListener('keydown', onKey);
    try {
      localStorage.setItem(HINTED, '1');
    } catch {
      // as above
    }
  };
  const onKey = (e: KeyboardEvent) => e.code === 'KeyN' && done();
  const el = h(
    'div.first-hint',
    { role: 'note' },
    h('span', {}, 'Press ', h('span.key', {}, 'N'), ' to go to whoever needs you, ', h('span.key', {}, 'M'), ' for the map, ', h('span.key', {}, 'H'), ' for help'),
    h('button', { type: 'button', 'aria-label': 'Got it', title: 'Got it', onclick: done }, '✕'),
  );
  window.addEventListener('keydown', onKey);
  hud.append(el);
}
