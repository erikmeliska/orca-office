import type { Slice } from '../store';

// The office's clock, lined up from pings. agent-office kept it in the jukebox's slice; the jukebox is
// gone (design.md #16), the DJ on the roof and the workers' timers still keep time by it.
declare module '../store' {
  interface Store {
    /** The office's clock minus performance.now(), from the quickest ping (see 'pong'). Only this slice sets it. */
    clock?: { offset: number; rtt: number };
    /** The office's clock (ms since 1970) as near as this page can tell, which the DJ on the roof keeps time by. */
    officeNow(): number;
  }
}

export const clock: Slice = {
  init(s) {
    s.clock = undefined;
  },
  methods: {
    officeNow() {
      return this.clock ? performance.now() + this.clock.offset : Date.now();
    },
  },
  on: {
    welcome(s) {
      s.clock = undefined; // compared again, in case it's another office (or the same one, restarted)
    },
    pong(s, m) {
      // The answer that came back quickest says best how the two clocks line up.
      const rtt = performance.now() - m.at;
      if (s.clock && rtt >= s.clock.rtt) return;
      s.clock = { offset: m.now - (m.at + rtt / 2), rtt };
    },
  },
};
