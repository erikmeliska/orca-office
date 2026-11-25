// The Command Center's columns (M7, roadmap B3): the whole building at once, sorted into Needs you /
// Working / Stuck / Done / Ended, filtered by Orca's Kanban status (B10). No three.js and no page
// here, so the tests run it as it is. Text is only ever the bridge's bubbles.

import type { OrcaAsks, OrcaRosterFloor, OrcaWaiting } from '@orca-office/shared/office/protocol/orca';
import { kanbanRank } from '@orca-office/shared/office/kanban';
import { stuckText, type StuckRule } from '@orca-office/shared/office/stuck';

export type Column = 'needs' | 'working' | 'stuck' | 'done' | 'ended';

export const COLUMNS: readonly { id: Column; title: string; empty: string }[] = [
  { id: 'needs', title: '🙋 Needs you', empty: 'Nobody is waiting for you' },
  { id: 'working', title: '⌨️ Working', empty: 'Nobody is working' },
  { id: 'stuck', title: '😴 Stuck?', empty: 'Nobody looks stuck' },
  { id: 'done', title: '✅ Done', empty: 'Nothing new is done' },
  { id: 'ended', title: '💤 Ended', empty: 'Nothing here' },
];

export interface Card {
  /** The figure's id, or `gate:<id>`. */
  key: string;
  kind: 'agent' | 'gate';
  column: Column;
  floor: string;
  floorName: string;
  workerId: string | null;
  deskId: string | null;
  /** The worktree (or bot) it's named after; "Decision" for a gate. */
  name: string;
  branch?: string;
  kanban?: string;
  /** Its bubble: what it asks, is on, or said last (≤120). */
  text?: string;
  /** Since when it's been in this column's state (ms); for a stuck one, what makes it look stuck. */
  since?: number;
  stuckWhy?: string;
  asks?: OrcaAsks;
  /** A terminal agent on this machine: it can be answered from the card (B1). */
  terminal: boolean;
  chat: boolean;
  bot: boolean;
}

/** Everyone in the building in their columns, each column longest-waiting first. `kanban`: only that status ('' = all). */
export function commandCards(roster: readonly OrcaRosterFloor[], waiting: readonly OrcaWaiting[], rule: StuckRule, now: number, kanban = ''): Record<Column, Card[]> {
  const out: Record<Column, Card[]> = { needs: [], working: [], stuck: [], done: [], ended: [] };
  const asked = new Map(waiting.filter((w) => w.kind === 'agent' && w.workerId).map((w) => [w.workerId!, w]));
  for (const f of roster) {
    for (const w of f.workers) {
      const stuck = w.status === 'working' ? stuckText(w, now, rule) : '';
      const column: Column = w.status === 'needs_input' ? 'needs' : stuck ? 'stuck' : w.status === 'working' ? 'working' : w.status === 'done' && w.unread ? 'done' : 'ended';
      const a = asked.get(w.id);
      out[column].push({
        key: w.id,
        kind: 'agent',
        column,
        floor: f.floor,
        floorName: f.name,
        workerId: w.id,
        deskId: w.deskId,
        name: w.name,
        ...(w.branch ? { branch: w.branch } : {}),
        ...(w.kanban ? { kanban: w.kanban } : {}),
        ...(w.summary ? { text: w.summary } : {}),
        // A wait's since must be the bridge's own (B1 answers name it).
        since: column === 'needs' ? (a?.since ?? w.since) : column === 'stuck' ? Math.min(w.quietSince ?? now, w.workingSince ?? now) : w.since,
        ...(stuck ? { stuckWhy: stuck } : {}),
        ...((a?.asks ?? w.asks) ? { asks: a?.asks ?? w.asks } : {}),
        terminal: !!w.terminal,
        chat: !!w.chat,
        bot: !!w.bot,
      });
    }
  }
  // The decision gates of the project rooms: they need you too, decided in Orca.
  for (const g of waiting) {
    if (g.kind !== 'gate') continue;
    out.needs.push({ key: g.key, kind: 'gate', column: 'needs', floor: g.floor, floorName: g.floorName, workerId: null, deskId: g.deskId, name: '⚖️ Decision', ...(g.ask ? { text: g.ask } : {}), since: g.since, terminal: false, chat: false, bot: false });
  }
  for (const c of Object.keys(out) as Column[]) {
    if (kanban) out[c] = out[c].filter((x) => x.kanban === kanban);
    out[c].sort((a, b) => (a.since ?? now) - (b.since ?? now) || a.name.localeCompare(b.name));
  }
  return out;
}

/** The Kanban statuses anyone in the building is in, for the filter (B10). */
export function kanbanStatuses(roster: readonly OrcaRosterFloor[]): string[] {
  const all = new Set<string>();
  for (const f of roster) for (const w of f.workers) if (w.kanban) all.add(w.kanban);
  return [...all].sort((a, b) => kanbanRank(a) - kanbanRank(b) || a.localeCompare(b));
}
