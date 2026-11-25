import type { OrcaRosterFloor, OrcaWaiting } from '@orca-office/shared/office/protocol/orca';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Everything in the building waiting for you (agents asking, decision gates), longest first (M6 A1/A2). */
    waitingAll: OrcaWaiting[];
    /** Every figure on every floor (M6 A6), for ⌘K and the Workers panel. */
    roster: OrcaRosterFloor[];
  }
  interface Topics {
    waitingAll: true;
    roster: true;
  }
}

export const waiting: Slice = {
  init(s) {
    s.waitingAll = [];
    s.roster = [];
  },
  on: {
    'orca.waiting'(s, m) {
      s.waitingAll = m.items;
      return ['waitingAll'];
    },
    'orca.roster'(s, m) {
      s.roster = m.floors;
      return ['roster'];
    },
  },
};
