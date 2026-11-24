/** The board agents: what each is for, and the ones waiting by their boards before anyone has asked them anything. */
import type { StationKind } from '@orca-office/shared/office/layout';
import type { Worker } from '../world/character';
import type { DeskView } from '../world/types';
import type { World } from '../world/world';

/** What each board agent is for: its board's icon, what it offers on the card over its head, and an example ask. */
export const STATION_INFO: Record<StationKind, { icon: string; offer: string; does: string; example: string }> = {
  issues: { icon: '📌', offer: 'Ask me about issues', does: 'I file, find, triage, label and close them', example: 'File an issue: the dog walks straight through the jukebox' },
  pulls: { icon: '🔀', offer: 'Ask me about PRs', does: 'I sum up, review, comment on and merge them', example: 'Review the newest PR and tell me if it’s ready to merge' },
  queue: { icon: '📋', offer: 'Ask me to queue work', does: 'I turn it into tasks for fresh workers', example: 'Queue every open bug issue, most important first' },
};

/** A board agent waiting by its board before anyone has asked it anything (see buildKiosk), and where. */
export interface IdleAgent {
  model: Worker;
  view: DeskView;
}

/**
 * The board agents waiting by their boards in `w`: none in orca-office. agent-office ran an agent at
 * each kiosk (issues, PRs, the task queue) from its own server; orca-office has no queue or board
 * agents (design.md #16), so the kiosks stand empty until a worker sits there.
 */
export function idleAgentsIn(_w: World): IdleAgent[] {
  return [];
}
