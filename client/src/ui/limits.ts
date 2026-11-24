import { limitLevel, worstWindow, type PlanLimits, type PlanWindow, type ProviderLimits } from '@orca-office/shared/office/protocol';
import { store } from '../state';
import { $, h } from './dom';
import { panelHide } from './menu';

/** Numbers older than this say when they were read. */
const STALE_MS = 10 * 60_000;

/** "in 12m", "in 2h 5m", or "Tue 5:00 AM" once it is more than a day out. */
export function fmtReset(at: number, now = Date.now()): string {
  const mins = Math.ceil((at - now) / 60_000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins}m`;
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Why a provider shows no windows, in a few words; '' when it has some to show. */
export function providerNote(p: ProviderLimits): string {
  switch (p.status) {
    case 'loading':
      return 'reading…';
    case 'no-plan':
      return 'API key, no plan limits';
    case 'signed-out':
      return 'not signed in';
    case 'missing':
      return 'not installed';
    case 'error':
      return 'couldn’t read the limits';
    default:
      return p.windows.length ? '' : 'no window started yet';
  }
}

function windowRow(p: ProviderLimits, w: PlanWindow, now: number): HTMLElement[] {
  const pct = Math.round(w.pct);
  const when = w.resetsAt ? new Date(w.resetsAt).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' }) : '';
  const scope = w.label === 'Week' ? ' (all models)' : '';
  const title = `${p.name} ${w.label}${scope}: ${pct}% used${when ? `\nStarts over ${when}` : ''}`;
  return [
    h(
      'div.row',
      { title },
      h('span.what', {}, w.label),
      h('b', { class: limitLevel(w.pct) }, `${pct}%`),
      w.resetsAt ? h('span.reset', {}, `resets ${fmtReset(w.resetsAt, now)}`) : null,
    ),
    h('div.meter', { class: limitLevel(w.pct), title, role: 'progressbar', 'aria-label': `${p.name} ${w.label}`, 'aria-valuenow': pct }, h('div.fill', { style: `width:${w.pct}%` })),
  ];
}

function providerBlock(p: ProviderLimits, now: number): HTMLElement {
  const note = providerNote(p);
  const resets = p.resets ? `${p.resets} free reset${p.resets === 1 ? '' : 's'}` : '';
  return h(
    'div.provider',
    { 'data-provider': p.id, class: note && !p.windows.length ? 'off' : '' },
    h('h4', {}, p.name, p.plan ? h('span.plan', {}, cap(p.plan)) : null, note && !p.windows.length ? h('span.note', {}, note) : null),
    ...p.windows.flatMap((w) => windowRow(p, w, now)),
    resets ? h('div.row.muted', { title: 'Codex rate-limit resets you have earned and not used yet' }, resets) : null,
    p.windows.length && p.status === 'ok' && p.at && now - p.at > STALE_MS ? h('div.row.muted', {}, `As of ${new Date(p.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`) : null,
  );
}

/** Every provider whose CLI is on the office's machine, read or not. */
export function shownProviders(l: PlanLimits): ProviderLimits[] {
  return l.providers.filter((p) => p.status !== 'missing');
}

/** The plan limits of every provider, under the workers. Click to read them again. */
export function renderLimits() {
  const s = store.limits;
  const el = $('limits');
  const shown = shownProviders(s);
  el.classList.toggle('hidden', !shown.length);
  if (!shown.length) return;
  const now = Date.now();
  el.replaceChildren(h('h3', {}, 'Usage', panelHide('limits')), ...shown.map((p) => providerBlock(p, now)));
}

/**
 * The top bar's meter: the window closest to its limit across the providers, e.g. "Codex 83%", in
 * Orca's colours; "—" when no provider could be read; null when no provider's CLI is installed.
 */
export function limitsChip(l: PlanLimits = store.limits): { name: string; pct: number | null; level: string; title: string } | null {
  const shown = shownProviders(l);
  if (!shown.length) return null;
  const worst = worstWindow(l);
  const now = Date.now();
  const lines = shown.map((p) => {
    const ws = p.windows.map((w) => `${w.label} ${Math.round(w.pct)}%${w.resetsAt ? ` (resets ${fmtReset(w.resetsAt, now)})` : ''}`);
    return `${p.name}: ${ws.length ? ws.join(', ') : providerNote(p)}`;
  });
  if (!worst) return { name: 'Usage', pct: null, level: '', title: `No plan limits to show\n${lines.join('\n')}` };
  return { name: worst.provider.name, pct: Math.round(worst.window.pct), level: limitLevel(worst.window.pct), title: `Most used: ${worst.provider.name} ${worst.window.label}\n${lines.join('\n')}` };
}
