import { canLabel } from '@orca-office/shared/office/floorplan';
import type { GhIssue, WorkerInfo } from '@orca-office/shared/office/protocol';
import { isAsleep } from '@orca-office/shared/office/status';
import type { Interactable } from './world/types';

export const DESK_KEYS = { KeyE: 'E', KeyP: 'P', KeyR: 'R', KeyX: 'X', KeyB: 'B', KeyC: 'C', KeyO: 'O', KeyL: 'L' } as const;
export type DeskKey = (typeof DESK_KEYS)[keyof typeof DESK_KEYS];

export interface InteractionState {
  worker?: WorkerInfo;
  room: boolean;
  note: GhIssue | null;
  /** On Orca (M3): the desk keys are Orca's light control (features/workers/actions.ts). */
  orca?: boolean;
}

/** Whether a desk key has an action at the interaction currently in reach. */
export function interactionAvailable(it: Interactable | null, key: DeskKey, state: InteractionState): boolean {
  if (!it) return false;

  if (it.kind === 'desk') {
    if (!it.deskId) return false;
    // Any desk can have a sign hung over it, whoever sits there (not a bean bag).
    // On Orca: E terminal / last message / new task, P prompt, O open in Orca, R mark read, C comment.
    if (state.orca) {
      const w = state.worker;
      if (key === 'E' || key === 'C' || key === 'O') return true;
      if (key === 'P') return !!w?.orca?.terminal;
      if (key === 'R') return !!w && !w.acked;
      return false;
    }
    if (key === 'L') return canLabel(it.deskId);
    if (!state.worker && state.room) return key === 'E';
    if (key === 'B') return !state.worker;
    if (key === 'P' || key === 'E') return true;
    if (key === 'R') return !!state.worker && isAsleep(state.worker.status);
    return !!state.worker && (key === 'C' || key === 'X' || key === 'O');
  }

  if (it.kind === 'station') {
    if (!it.deskId) return false;
    return !!state.worker && (key === 'O' || key === 'X');
  }

  if (state.note && it.kind === 'issues') return key === 'E' || key === 'O';
  if (key !== 'E') return false;

  if (it.kind === 'decor') return !!it.decorId;
  if (it.kind === 'seat') return !!it.seatId;
  if (it.kind === 'pole') return it.pole !== undefined;
  return true;
}
