// The workers list in the sidebar: every worker on your floor, what it's on, and what it has spent,
// then the other floors' (M6 A6). One that needs you goes to the top, in red, saying what it's asking and for how long.

import { needyFirst } from '../nextup';
import { store } from '../state';
import { DESK_BY_ID } from '@orca-office/shared/office/layout';
import { $, h, STATUS_LABEL, timeAgo } from './dom';
import { usageLabel, usageTitle } from './usage';
import { STUCK_DEFAULTS, stuckText, type StuckRule } from '@orca-office/shared/office/stuck';
import { providerLabel, providerUsageState, providerWaitingLabel, resolvedProvider, modelBadge } from './provider';

/** Going to a figure on another floor (M6 A6): its floor, id, desk and name. */
export type GoToFigure = (floor: string, workerId: string, deskId: string, name: string) => void;

export function renderWorkers(onOpen: (id: string) => void, onGo?: GoToFigure, rule: StuckRule = STUCK_DEFAULTS) {
  const ul = $('workers');
  ul.replaceChildren();
  const now = Date.now();
  // Maybe stuck (M7 B5), anywhere in the building: apart from the ones that really need you, and only a guess.
  const stuck = stuckInBuilding(rule, now);
  if (stuck.length) {
    ul.append(h('li.floor-head.stuck-head', {}, `😴 Maybe stuck · ${stuck.length}`));
    for (const s of stuck) {
      const here = s.floor === store.floor;
      ul.append(
        h(
          'li.stuck-row',
          { onclick: () => (here ? onOpen(s.id) : onGo?.(s.floor, s.id, s.deskId, s.name)), title: here ? `Open ${s.name}'s terminal` : `Go to ${s.name} on ${s.floorName}` },
          h('span.name', {}, s.name, h('span.sub', {}, [s.text, !here && `🏢 ${s.floorName}`].filter(Boolean).join(' · '))),
          h('span.pill.stuck', {}, 'STUCK?'),
        ),
      );
    }
  }
  const workers = needyFirst(store.workers.values());
  for (const w of workers) {
    const asking = w.status === 'needs_input' && !w.lost;
    const provider = w.kind === 'agent' ? providerLabel(w.provider, store.project) : null;
    const providerKind = w.kind === 'agent' ? resolvedProvider(w.provider, store.project) : undefined;
    const usageState = w.kind === 'agent' ? providerUsageState(w.provider, store.project, w.usage) : undefined;
    const waiting = usageState === 'waiting' ? providerWaitingLabel(providerKind, store.project) : '';
    const usageNote = usageState === 'untracked' ? ' · usage untracked' : waiting ? ` · ${waiting}` : '';
    const badge = w.kind === 'agent' ? modelBadge(w.provider, w.model, w.effort, w.usage?.model) : undefined;
    const branch = w.worktree?.branch ?? w.orca?.branch;
    const sub = [provider && `⚙️ ${provider}${badge ? ` · ${badge}` : ''}${usageNote}`, branch && branch !== w.name && `🌿 ${branch}`, w.repos?.length && `🗂️ ${w.repos.length + 1} repos`, w.pr && `🔀 PR #${w.pr.number}`, w.activity || w.title || w.prompt].filter(Boolean).join(' · ');
    // What it's stopped on, and since when, on a line of its own under its name.
    const ask = asking ? h('span.ask', {}, `🙋 ${w.activity ?? w.task?.summary ?? 'Waiting on an answer'}${w.waitingSince ? ` · ${timeAgo(w.waitingSince)}` : ''}`) : null;
    ul.append(
      h(
        'li',
        { class: asking ? 'needs-you-row' : '', onclick: () => onOpen(w.id), title: asking ? `${w.name} needs you: open its terminal to answer` : `Open ${w.name}'s terminal` },
        h('span.dot', { style: `background:${w.color}` }),
        h('span.name', {}, w.name, sub ? h('span.sub', {}, sub) : null,
          usageState === 'tracked' && w.usage ? h('span.cost', { title: usageTitle(w.usage, providerKind) }, usageLabel(w.usage, providerKind)) : null),
        w.lost ? h('span.pill.lost', { title: 'Its worktree was deleted outside agent-office: open it to fix it' }, 'worktree deleted') : h('span.pill', { class: w.status }, asking ? 'NEEDS YOU' : (STATUS_LABEL[w.status] ?? w.status)),
        ask,
      ),
    );
  }
  if (!workers.length) ul.append(h('li.empty', {}, store.roster.length ? 'Nobody on this floor' : 'Walk up to a desk and press E to hire one'));
  // The other floors (A6): grouped by floor, the ones that need you first; a click goes there.
  for (const f of store.roster) {
    if (f.floor === store.floor || !f.workers.length || !onGo) continue;
    const rows = [...f.workers].sort((a, b) => Number(b.status === 'needs_input') - Number(a.status === 'needs_input'));
    ul.append(h('li.floor-head', {}, `🏢 ${f.name}`));
    for (const r of rows) {
      const asking = r.status === 'needs_input';
      ul.append(
        h(
          'li.away',
          { class: asking ? 'needs-you-row' : '', onclick: () => onGo(f.floor, r.id, r.deskId, r.name), title: `Go to ${r.name} on ${f.name}` },
          h('span.name', {}, r.name, h('span.sub', {}, [r.branch && r.branch !== r.name && `🌿 ${r.branch}`, r.summary].filter(Boolean).join(' · '))),
          h('span.pill', { class: r.status }, asking ? 'NEEDS YOU' : (STATUS_LABEL[r.status] ?? r.status)),
        ),
      );
    }
  }
  // The count is the workers hired onto desks and bean bags (and a meeting's table): the board agents
  // standing at the Issues, PR and queue kiosks are listed but aren't counted.
  const hired = workers.filter((w) => !DESK_BY_ID.get(w.deskId)?.station).length;
  $('worker-count').textContent = hired ? String(hired) : '';
  $('workers-panel').classList.toggle('needs-you-panel', workers.some((w) => w.status === 'needs_input') || store.waitingAll.length > 0);
}

/** Everyone in the building that looks stuck (M7 B5): from the roster (every floor), this floor's own if there's none. */
export function stuckInBuilding(rule: StuckRule, now: number): { id: string; name: string; floor: string; floorName: string; deskId: string; text: string }[] {
  const out: { id: string; name: string; floor: string; floorName: string; deskId: string; text: string; since: number }[] = [];
  const floors = store.roster.length
    ? store.roster
    : store.floor
      ? [{ floor: store.floor, name: '', workers: [...store.workers.values()].map((w) => ({ id: w.id, name: w.name, status: w.status, deskId: w.deskId, quietSince: w.orca?.quietSince, workingSince: w.workingSince })) }]
      : [];
  for (const f of floors) {
    for (const w of f.workers) {
      const text = stuckText(w, now, rule);
      if (text) out.push({ id: w.id, name: w.name, floor: f.floor, floorName: f.name, deskId: w.deskId, text, since: Math.min(w.quietSince ?? now, w.workingSince ?? now) });
    }
  }
  return out.sort((a, b) => a.since - b.since);
}
