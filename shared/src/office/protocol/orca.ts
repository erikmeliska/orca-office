// The bridge's link to Orca (orca-office, not agent-office): whether the Orca plugin is connected,
// and the office's light control over Orca (M3, design #14).

/** What a figure is in Orca, for what the office can do with it (WorkerInfo.orca). */
export interface OrcaWorkerInfo {
  /** A terminal agent on this machine: its live terminal opens in the office and takes typing. Chat agents and agents on other hosts have none. */
  terminal: boolean;
  /** On another host (a paired environment): shown, but the office can't act on it. */
  remote: boolean;
}

/** Agents the office can start in a new workspace; Orca's plugin worker allows the same (plugin/src/worker.ts). */
export const ORCA_AGENTS = ['claude', 'codex', 'gemini', 'opencode', 'copilot', 'cursor', 'pi'] as const;
export type OrcaAgent = (typeof ORCA_AGENTS)[number];

/** Bounds the bridge holds the page's messages to (and the worker its calls). */
export const ORCA_LIMITS = { send: 4096, prompt: 8000, comment: 2000, name: 60 } as const;

export type OrcaActionKind = 'type' | 'open' | 'read' | 'comment' | 'create' | 'terminal';

export type OrcaClientMsg =
  /** Show the figure's workspace in Orca and focus its terminal (`workerId`), or a desk's worktree (`deskId`). */
  | { t: 'orca.open'; workerId?: string; deskId?: string }
  /** Mark the desk's worktree read in Orca (clears its unread dot). */
  | { t: 'orca.read'; deskId: string }
  /** Set the desk's worktree comment in Orca ('' clears it). */
  | { t: 'orca.comment'; deskId: string; comment: string }
  /** Ask for the desk's worktree comment and unread state; answered with `orca.desk`. */
  | { t: 'orca.desk'; deskId: string }
  /** Start a task: a new worktree in the floor's repository with `agent` on `prompt`; progress comes as `orca.create`. */
  | { t: 'orca.create'; reqId: string; floor: string; agent: string; prompt: string; name?: string };

export type OrcaServerMsg =
  /** Sent after `welcome` and whenever it changes: false while Orca (its plugin) isn't connected to the bridge. */
  | { t: 'orca'; online: boolean }
  /** How an action went; `error` is a short reason (never terminal text). */
  | { t: 'orca.result'; action: OrcaActionKind; ok: boolean; error?: string; workerId?: string; deskId?: string }
  /** A desk's worktree in Orca: its comment and whether it is unread. */
  | { t: 'orca.desk'; deskId: string; comment: string; unread: boolean }
  /**
   * A task being started: `creating` (Orca makes the worktree), `created` (the agent is starting),
   * `ready` (its figure sat down at `deskId` on `floor`), `failed` (with a reason).
   */
  | { t: 'orca.create'; reqId: string; phase: 'creating' | 'created' | 'ready' | 'failed'; error?: string; floor?: string; deskId?: string };
