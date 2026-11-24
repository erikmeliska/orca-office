/**
 * Polls orchestration Runs and the mailbox through the CLI, one call at a time (0.1–0.2 s each):
 * every RUNS_EVERY_MS the run list and the mailbox; a Run that is going on (open tasks, a pending
 * gate) has its tasks, gates and workers read each time, a quiet one only every QUIET_EVERY_MS
 * (or at once when its `updated_at` moves). Errors are reported by kind only.
 */
import type { RunJson } from './cli.js';
import { isLive, parseGates, parseInbox, parseRunList, parseRunShow, parseTasks, parseWorkers, type InboxMessage, type OrcaRun } from './runs.js';

export const RUNS_EVERY_MS = 10_000;
export const QUIET_EVERY_MS = 60_000;
/** A finished Run stays on the roof this long after its last change. */
export const RECENT_MS = 2 * 60 * 60_000;
/** Runs read at most (newest first, as Orca lists them). */
export const MAX_RUNS = 8;
export const INBOX_LIMIT = 50;

export interface RunsSink {
  runs(runs: OrcaRun[], now: number): void;
  inbox(messages: InboxMessage[], now: number): void;
  error(what: string): void;
}

export class RunsPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private known = new Map<string, { run: OrcaRun; checkedAt: number }>();

  constructor(
    private run: RunJson,
    private sink: RunsSink,
    private now: () => number = Date.now,
    private everyMs = RUNS_EVERY_MS,
  ) {}

  start(): void {
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pollRuns();
    } catch (err) {
      this.sink.error((err as Error).message);
    }
    try {
      this.sink.inbox(parseInbox(await this.run(['orchestration', 'inbox', '--limit', String(INBOX_LIMIT), '--json'])), this.now());
    } catch (err) {
      this.sink.error((err as Error).message);
    }
    this.running = false;
    this.timer = setTimeout(() => void this.poll(), this.everyMs);
  }

  private async pollRuns(): Promise<void> {
    const ids = parseRunList(await this.run(['orchestration', 'run-list', '--json'])).slice(0, MAX_RUNS);
    const now = this.now();
    const next = new Map<string, { run: OrcaRun; checkedAt: number }>();
    for (const { id } of ids) {
      const prev = this.known.get(id);
      const live = !!prev && isLive(prev.run, now, RECENT_MS);
      // A quiet Run: looked at again only now and then.
      if (prev && !live && now - prev.checkedAt < QUIET_EVERY_MS) {
        next.set(id, prev);
        continue;
      }
      const head = parseRunShow(await this.run(['orchestration', 'run-show', '--id', id, '--full', '--json']));
      if (!head) continue;
      const unchanged = prev && !live && prev.run.updatedAt === head.updatedAt && now - head.updatedAt > RECENT_MS;
      if (unchanged) {
        next.set(id, { run: { ...prev.run, ...head }, checkedAt: now });
        continue;
      }
      const tasks = parseTasks(await this.run(['orchestration', 'task-list', '--run', id, '--json']));
      const gates = parseGates(await this.run(['orchestration', 'gate-list', '--run', id, '--status', 'pending', '--json']));
      const workers = tasks.length ? parseWorkers(await this.run(['orchestration', 'worker-list', '--run', id, '--json'])) : [];
      next.set(id, { run: { ...head, tasks, gates, workers }, checkedAt: now });
    }
    this.known = next;
    this.sink.runs([...next.values()].map((k) => k.run), now);
  }
}
