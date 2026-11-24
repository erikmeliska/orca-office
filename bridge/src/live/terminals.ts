/**
 * The live terminal in the office (design #19, issue #23): the bridge polls `terminal.read` about
 * 4× a second, only for terminals an office page has open, and sends the page the text when it
 * changed. Orca's `terminal.read` gives plain lines (no colours, no cursor), so each change is a
 * whole `term.snapshot` with cols/rows 0: the page keeps its own size.
 *
 * The text is kept in memory only, for the one comparison with the next read; never stored or logged.
 */
import type { ServerMsg } from '@orca-office/shared/office/protocol';
import type { CallResult } from '../plugin-link.js';

export const READ_EVERY_MS = 250;
/** Lines read per poll: a screen and some scrollback. */
export const READ_LINES = 500;
/** Failed reads in a row before the page is told the terminal is gone. */
const MAX_FAILS = 3;

export interface TerminalViewer {
  workerId: string;
  send(msgs: ServerMsg[]): void;
}

interface Watched {
  viewers: Set<TerminalViewer>;
  last: string | null;
  timer: ReturnType<typeof setInterval>;
  busy: boolean;
  fails: number;
}

export class TerminalWatch {
  private watched = new Map<string, Watched>();

  constructor(
    private read: (terminalId: string, maxLines: number) => Promise<CallResult>,
    private everyMs = READ_EVERY_MS,
  ) {}

  /** Starts sending this terminal to `viewer`; returns how to stop. */
  watch(terminalId: string, viewer: TerminalViewer): () => void {
    let w = this.watched.get(terminalId);
    if (!w) {
      w = { viewers: new Set(), last: null, timer: setInterval(() => void this.poll(terminalId), this.everyMs), busy: false, fails: 0 };
      this.watched.set(terminalId, w);
      void this.poll(terminalId);
    } else if (w.last !== null) viewer.send([snapshot(viewer.workerId, w.last)]);
    w.viewers.add(viewer);
    return () => this.unwatch(terminalId, viewer);
  }

  /** Terminals polled right now. */
  get size(): number {
    return this.watched.size;
  }

  /** Reads now (after typing, so the echo shows without waiting for the next poll). */
  nudge(terminalId: string): void {
    if (this.watched.has(terminalId)) void this.poll(terminalId);
  }

  private unwatch(terminalId: string, viewer: TerminalViewer) {
    const w = this.watched.get(terminalId);
    if (!w) return;
    w.viewers.delete(viewer);
    if (w.viewers.size) return;
    clearInterval(w.timer);
    this.watched.delete(terminalId);
  }

  async poll(terminalId: string): Promise<void> {
    const w = this.watched.get(terminalId);
    if (!w || w.busy) return;
    w.busy = true;
    const r = await this.read(terminalId, READ_LINES);
    w.busy = false;
    if (this.watched.get(terminalId) !== w) return;
    const lines = r.ok ? (r.value as { lines?: unknown } | undefined)?.lines : undefined;
    if (!Array.isArray(lines)) {
      if (++w.fails < MAX_FAILS) return;
      for (const v of w.viewers) v.send([{ t: 'orca.result', action: 'terminal', ok: false, error: r.error ?? 'unreadable', workerId: v.workerId }]);
      clearInterval(w.timer);
      this.watched.delete(terminalId);
      return;
    }
    w.fails = 0;
    const text = lines.filter((l): l is string => typeof l === 'string').join('\r\n');
    if (text === w.last) return;
    w.last = text;
    for (const v of w.viewers) v.send([snapshot(v.workerId, text)]);
  }
}

function snapshot(workerId: string, data: string): ServerMsg {
  return { t: 'term.snapshot', workerId, data, cols: 0, rows: 0 };
}
