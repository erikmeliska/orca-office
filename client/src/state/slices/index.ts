// Every slice of the store, the core's included, in the one order the store runs them in: the order
// they take in each message and each floor you arrive on, and so the order their topics fire in. On
// `welcome`, after the map (see map.ts), the floor's topics fire from `floor` on down, then everyone
// else's from the top; on every other message, the topics fire top to bottom. That's the order the
// office has always fired them in, so a new slice goes at the end.
//
// Each slice's module also adds its fields and topics to Store and Topics (see ../store.ts), which only
// happens for a module that's imported: here.

import type { Slice } from '../store';
import { building, floor, me, presence } from '../core';
import { ball } from './ball';
import { cabinet } from './cabinet';
import { clock } from './clock';
import { decor } from './decor';
import { dog } from './dog';
import { floorPlan } from './floor-plan';
import { jail } from './jail';
import { leaveOnMerge } from './leave-on-merge';
import { machine } from './machine';
import { map } from './map';
import { notify } from './notify';
import { prompts } from './prompts';
import { services } from './services';
import { sky } from './sky';
import { theme } from './theme';
import { upgrade } from './upgrade';
import { usage } from './usage';
import { waiting } from './waiting';

export const SLICES: readonly Slice[] = [
  presence,
  upgrade,
  usage,
  me,
  notify,
  machine,
  building,
  sky,
  theme,
  prompts,
  leaveOnMerge,
  map,
  floor,
  decor,
  floorPlan,
  services,
  dog,
  clock,
  cabinet,
  ball,
  jail,
  waiting,
];
