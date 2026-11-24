/**
 * A token bucket: `capacity` at most, refilled at `perSecond`. `take(n)` spends n if it can.
 * The office rate-limits what the page can make Orca do (design #20): typing and new tasks.
 */
export class Bucket {
  private level: number;
  private at: number;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    now = Date.now(),
  ) {
    this.level = capacity;
    this.at = now;
  }

  take(n = 1, now = Date.now()): boolean {
    this.level = Math.min(this.capacity, this.level + ((now - this.at) / 1000) * this.perSecond);
    this.at = now;
    if (n > this.level) return false;
    this.level -= n;
    return true;
  }
}

/** The limits for one office page. */
export function pageLimits(now = Date.now()) {
  return {
    // Keystrokes: a burst of 200 frames, 40 a second after; and 64 KiB of text, 8 KiB a second.
    keys: new Bucket(200, 40, now),
    bytes: new Bucket(64 * 1024, 8 * 1024, now),
    // New tasks: 3 at once, then one a minute.
    create: new Bucket(3, 1 / 60, now),
    // Open in Orca, mark read, comment, desk lookups.
    other: new Bucket(20, 2, now),
  };
}
export type PageLimits = ReturnType<typeof pageLimits>;
