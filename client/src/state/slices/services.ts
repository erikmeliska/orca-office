import type { ServicesState } from '@orca-office/shared/office/protocol';
import type { Slice } from '../store';

declare module '../store' {
  interface Store {
    /** The dev servers running in the floor's worktrees (orca ports). */
    services: ServicesState;
  }
  interface Topics {
    services: true;
  }
}

export const services: Slice = {
  init(s) {
    s.services = { items: [] };
  },
  on: {
    services(s, m) {
      s.services = m.state;
      return ['services'];
    },
  },
  enter(s, v) {
    s.services = v.services;
    return ['services'];
  },
};
