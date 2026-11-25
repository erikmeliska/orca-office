// Is a working agent stuck? (M7, roadmap B5). Orca says nothing about an agent that hangs: it stays
// "working". The office guesses from how long Orca has been quiet about it (no state, no tool hook,
// no new last message) and how long it has been working at a stretch. Only a guess: "stuck?".

/** How long without a word from Orca, and how long working at a stretch, before a worker looks stuck. */
export interface StuckRule {
  /** Minutes without an event or a hook. */
  quietMin: number;
  /** Hours working at a stretch. */
  longHours: number;
}

export const STUCK_DEFAULTS: StuckRule = { quietMin: 15, longHours: 4 };
/** What Settings → Stuck offers. */
export const STUCK_QUIET_CHOICES = [5, 10, 15, 30, 60] as const;
export const STUCK_LONG_CHOICES = [1, 2, 4, 8, 24] as const;

export interface StuckInput {
  status: string;
  /** When Orca last said anything about it (ms). */
  quietSince?: number;
  /** Since when it has been working (ms). */
  workingSince?: number;
}

/** Why it looks stuck: Orca has been quiet about it, or it has worked for too long; null while it doesn't. */
export function stuckWhy(w: StuckInput, now: number, rule: StuckRule = STUCK_DEFAULTS): 'quiet' | 'long' | null {
  if (w.status !== 'working') return null;
  if (w.quietSince !== undefined && now - w.quietSince >= rule.quietMin * 60_000) return 'quiet';
  if (w.workingSince !== undefined && now - w.workingSince >= rule.longHours * 3_600_000) return 'long';
  return null;
}

export const isStuck = (w: StuckInput, now: number, rule: StuckRule = STUCK_DEFAULTS) => stuckWhy(w, now, rule) !== null;

/** "quiet for 22 min" / "working for 1 d 3 h": what the stuck badge's line says. */
export function stuckText(w: StuckInput, now: number, rule: StuckRule = STUCK_DEFAULTS): string {
  const why = stuckWhy(w, now, rule);
  if (!why) return '';
  const ms = now - (why === 'quiet' ? w.quietSince! : w.workingSince!);
  return `${why === 'quiet' ? 'quiet for' : 'working for'} ${span(ms)}`;
}

/** 22 min, 3 h 05 min, 1 d 3 h. */
export function span(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
