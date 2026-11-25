// The review queue (M7, roadmap B4): this floor's agents that are done and have a pull/merge request
// Orca links to their worktree, longest waiting first, with what the repo board read about each
// (checks, size). No three.js and no page here, so the tests run it as it is.

import type { WorkerInfo } from '@orca-office/shared/office/protocol';
import type { OrcaCi, OrcaForgeItem, OrcaLink } from '@orca-office/shared/office/protocol/orca';

export interface ReviewItem {
  workerId: string;
  deskId: string;
  name: string;
  ref: string;
  title?: string;
  url?: string;
  ci?: OrcaCi;
  additions?: number;
  deletions?: number;
  /** Since when it has waited (done since). */
  since: number;
}

/** "#128" / "!17" → 128. */
const numberOf = (ref: string) => Number(/^[#!](\d+)$/.exec(ref)?.[1] ?? NaN);

export function reviewQueue(workers: Iterable<WorkerInfo>, linksOf: (deskId: string) => OrcaLink[], pulls: readonly OrcaForgeItem[]): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const w of workers) {
    if (w.status !== 'done' || !w.orca || w.orca.bot) continue;
    for (const l of linksOf(w.deskId)) {
      if (l.kind !== 'pr' && l.kind !== 'mr') continue;
      const p = pulls.find((x) => (x.kind === 'pr' || x.kind === 'mr') && x.number === numberOf(l.ref));
      // A closed or merged one isn't on the board's open list any more: nothing to review.
      if (pulls.length && !p) continue;
      out.push({
        workerId: w.id,
        deskId: w.deskId,
        name: w.name,
        ref: l.ref,
        ...((p?.title ?? l.title) ? { title: p?.title ?? l.title } : {}),
        ...((p?.url ?? l.url) ? { url: p?.url ?? l.url } : {}),
        ...(p?.ci ? { ci: p.ci } : {}),
        ...(p?.additions !== undefined ? { additions: p.additions } : {}),
        ...(p?.deletions !== undefined ? { deletions: p.deletions } : {}),
        since: w.waitingSince ?? w.createdAt,
      });
    }
  }
  return out.sort((a, b) => a.since - b.since || a.name.localeCompare(b.name));
}

export const CI_LABEL: Record<OrcaCi, string> = { passing: '✅ checks pass', failing: '❌ checks fail', pending: '⏳ checks running', none: '— no checks' };
