import type { TeamState } from '@orca-office/shared/office/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** Who may tunnel into the office; only deployed offices manage it (see TeamState). */
    team: TeamState | null;
  }
  interface Topics {
    team: true;
  }
}

export const team: Slice = {
  init(s) {
    s.team = null;
  },
  on: {
    team(s, m) {
      s.team = m.state;
      return ['team'];
    },
  },
};
