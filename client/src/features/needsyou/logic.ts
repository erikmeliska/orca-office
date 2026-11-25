/**
 * What "a worker needs you" works out with nothing to draw: who just started asking and when to ring
 * again (the banner's text is in ../../waiting-all.ts). No three.js and no page here, so the tests run it as it is.
 */
import type { WorkerInfo, WorkerStatus } from '@orca-office/shared/office/protocol';

/** How long between reminders while a worker's still waiting on an answer nobody's looking at (ms). */
export const REMIND_EVERY = 30_000;

/** Nobody has its terminal open, so nobody's answering it. */
export const unattended = (w: WorkerInfo) => w.viewers.length === 0;

/** Tells a worker that has just stopped to ask something from one that was asking already when the page first saw it. */
export class Fresh {
  private last = new Map<string, WorkerStatus>();

  /** The workers that started needing you since the last look. */
  take(workers: ReadonlyMap<string, WorkerInfo>): WorkerInfo[] {
    const out: WorkerInfo[] = [];
    for (const w of workers.values()) {
      const before = this.last.get(w.id);
      this.last.set(w.id, w.status);
      if (before !== undefined && before !== w.status && w.status === 'needs_input') out.push(w);
    }
    // Gone, or on a floor you've left: new to the page if it comes back.
    for (const id of this.last.keys()) if (!workers.has(id)) this.last.delete(id);
    return out;
  }
}

/** When to ring again: every REMIND_EVERY for as long as someone's asking and nobody's at its terminal. */
export class Reminders {
  private last = 0;
  private waiting = false;

  /** The alarm just rang: the next reminder is a whole wait away. */
  rang(now: number) {
    this.last = now;
    this.waiting = true;
  }

  /** Nobody the last wait was for is here any more (you've changed floors): the next one starts from scratch. */
  quiet() {
    this.waiting = false;
  }

  /** Whether to ring now, for `asking` (the workers that need you). Says yes once per wait. */
  due(asking: readonly WorkerInfo[], now: number): boolean {
    if (!asking.some(unattended)) {
      this.waiting = false;
      return false;
    }
    // Someone's asking again (or was when the page came up): the wait starts here, quietly.
    if (!this.waiting) {
      this.rang(now);
      return false;
    }
    if (now - this.last < REMIND_EVERY) return false;
    this.last = now;
    return true;
  }
}
