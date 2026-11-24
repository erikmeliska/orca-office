// The read-only LAN view (v2, #39): what a TV or a phone on the LAN gets from the bridge's LAN port.
// Floors, desks, figures, states and badges; never text an agent, a prompt, a terminal or a chat wrote.

import type { AgentProvider } from '../providers.js';
import type { WorkerAction, WorkerStatus } from './workers.js';

export interface LanFigure {
  /** The office's made-up name for the figure ("Ada"), never Orca's title. */
  name: string;
  color: string;
  status: WorkerStatus;
  provider?: AgentProvider;
  /** What it acts out (read, edit, test…), not the tool's input. */
  action?: WorkerAction;
  /** Claude Code subagents around it. */
  helpers?: number;
  /** On another host. */
  remote?: boolean;
  /** An Orca bot: its name. */
  bot?: string;
}

export interface LanDesk {
  /** The desk's sign: the worktree's name in Orca (on the Staff floor the bot's). Empty in project rooms. */
  name: string;
  figures: LanFigure[];
}

export interface LanFloor {
  id: string;
  /** The repository's name, "Staff", or "Project room" (a Run's objective is private, design #20). */
  name: string;
  room?: 'staff' | 'project';
  /** Figures waiting for you (and open decisions in a project room). */
  waiting: number;
  busy: number;
  workers: number;
  desks: LanDesk[];
}

/** The whole building, read only: sent on connect and whenever it changes. */
export interface LanView {
  t: 'lan.view';
  online: boolean;
  floors: LanFloor[];
  at: number;
}

/** What the LAN socket takes from a page: nothing but a ping. Anything else closes it. */
export type LanClientMsg = { t: 'ping'; at: number };
export type LanServerMsg = LanView | { t: 'pong'; at: number; now: number };

/** Bounds of the LAN side. */
export const LAN_LIMITS = { sockets: 16, frame: 256, messagesPerMinute: 120 } as const;
