import type { OrcaWaiting } from '@orca-office/shared/office/protocol/orca';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Everything in the building waiting for you (agents asking, decision gates), longest first (M6 A1/A2). */
    waitingAll: OrcaWaiting[];
  }
  interface Topics {
    waitingAll: true;
  }
}

export const waiting: Slice = {
  init(s) {
    s.waitingAll = [];
  },
  on: {
    'orca.waiting'(s, m) {
      s.waitingAll = m.items;
      return ['waitingAll'];
    },
  },
};
