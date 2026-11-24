// Wire protocol between browser and server. Every WebSocket frame is one JSON object.
//
// Each part of the office keeps its state types and its messages in ./protocol/<domain>.ts; this
// file puts them back together, so everything is still imported from here, and makes the two
// unions every frame is one of.

import type { ChangesClientMsg, ChangesServerMsg } from './protocol/changes.js';
import type { FloorClientMsg, FloorServerMsg, PlanClientMsg } from './protocol/floors.js';
import type { GitHubClientMsg, GitHubServerMsg } from './protocol/github.js';
import type { OrcaServerMsg } from './protocol/orca.js';
import type { PresenceClientMsg, PresenceServerMsg } from './protocol/presence.js';
import type { RooftopClientMsg, RooftopServerMsg } from './protocol/rooftop.js';
import type { SettingsClientMsg, SettingsServerMsg } from './protocol/settings.js';
import type { BallClientMsg, CabinetClientMsg, DecorClientMsg, DogClientMsg, ToysServerMsg } from './protocol/toys.js';
import type { UsageClientMsg, UsageServerMsg } from './protocol/usage.js';
import type { WorkerClientMsg, WorkerServerMsg } from './protocol/workers.js';

export * from './protocol/me.js';
export * from './protocol/agents.js';
export * from './protocol/changes.js';
export * from './protocol/floors.js';
export * from './protocol/github.js';
export * from './protocol/orca.js';
export * from './protocol/presence.js';
export * from './protocol/rooftop.js';
export * from './protocol/settings.js';
export * from './protocol/toys.js';
export * from './protocol/usage.js';
export * from './protocol/workers.js';

export type ClientMsg =
  | PresenceClientMsg
  | RooftopClientMsg
  | WorkerClientMsg
  | GitHubClientMsg
  | FloorClientMsg
  | PlanClientMsg
  | ChangesClientMsg
  | SettingsClientMsg
  | UsageClientMsg
  | DecorClientMsg
  | CabinetClientMsg
  | BallClientMsg
  | DogClientMsg;

export type ServerMsg =
  | PresenceServerMsg
  | RooftopServerMsg
  | WorkerServerMsg
  | GitHubServerMsg
  | FloorServerMsg
  | ChangesServerMsg
  | SettingsServerMsg
  | UsageServerMsg
  | ToysServerMsg
  | OrcaServerMsg;
