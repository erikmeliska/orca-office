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
export const ORCA_AGENTS = ['claude', 'codex', 'antigravity', 'opencode', 'copilot', 'cursor', 'pi'] as const;
export type OrcaAgent = (typeof ORCA_AGENTS)[number];

/** How the New task picker names an agent; Orca's id where it differs from the CLI people know. */
export const ORCA_AGENT_LABELS: Partial<Record<OrcaAgent, string>> = { antigravity: 'agy (Antigravity)' };

/** Bounds the bridge holds the page's messages to (and the worker its calls). */
export const ORCA_LIMITS = { send: 4096, prompt: 8000, comment: 2000, name: 60 } as const;

export type OrcaActionKind = 'type' | 'open' | 'read' | 'comment' | 'create' | 'terminal' | 'chat';

/** One entry of a chat agent's conversation, read-only (`orca agent read`): a message, or a tool it used. */
export type OrcaChatEntry = { role: 'user' | 'assistant'; text: string; shortened?: boolean } | { tool: string; state: string | null };

/** Entries a chat panel shows (the newest), and the longest text an entry carries. */
export const ORCA_CHAT = { entries: 50, text: 20_000 } as const;

/**
 * Something Orca links to a worktree (design #8, #17 v1; issue #32): a pull/merge request, an issue,
 * a Linear or Jira item, from `orca worktree list --json`. The office never asks a forge itself.
 */
export interface OrcaLink {
  provider: 'github' | 'gitlab' | 'linear' | 'jira' | 'bitbucket' | 'azure' | 'gitea' | 'other';
  kind: 'pr' | 'mr' | 'issue' | 'item';
  /** What it is called where it lives: "#12", "!7", "ENG-42". */
  ref: string;
  /** Where it opens (https only); none when Orca didn't say and the office can't tell. */
  url?: string;
  /** Its title, cut with toBubble to ORCA_LINK_TITLE characters (titles are private, design #20). */
  title?: string;
}

/** The longest link title the page gets. */
export const ORCA_LINK_TITLE = 60;
/** Links a desk shows at most. */
export const ORCA_LINKS_PER_DESK = 8;

export type OrcaClientMsg =
  /** Show the figure's workspace in Orca and focus its terminal (`workerId`), or a desk's worktree (`deskId`). */
  | { t: 'orca.open'; workerId?: string; deskId?: string }
  /** Mark the desk's worktree read in Orca (clears its unread dot). */
  | { t: 'orca.read'; deskId: string }
  /** Set the desk's worktree comment in Orca ('' clears it). */
  | { t: 'orca.comment'; deskId: string; comment: string }
  /** Ask for the desk's worktree comment and unread state; answered with `orca.desk`. */
  | { t: 'orca.desk'; deskId: string }
  /** Open a chat agent's conversation (read-only) in a panel; `orca.chat` comes while it's open. */
  | { t: 'orca.chat.open'; workerId: string }
  | { t: 'orca.chat.close'; workerId: string }
  /** Start a task: a new worktree in the floor's repository with `agent` on `prompt`; progress comes as `orca.create`. */
  | { t: 'orca.create'; reqId: string; floor: string; agent: string; prompt: string; name?: string };

export type OrcaServerMsg =
  /** Sent after `welcome` and whenever it changes: false while Orca (its plugin) isn't connected to the bridge. */
  | { t: 'orca'; online: boolean }
  /** How an action went; `error` is a short reason (never terminal text). */
  | { t: 'orca.result'; action: OrcaActionKind; ok: boolean; error?: string; workerId?: string; deskId?: string }
  /**
   * A chat agent's conversation, the newest ORCA_CHAT.entries, while its panel is open; sent again
   * when it changes. `state` is its latest turn's (`working`: a reply may still come); null unknown.
   */
  | { t: 'orca.chat'; workerId: string; state: string | null; entries: OrcaChatEntry[]; limited: boolean }
  /**
   * What Orca links to the desks of the page's floor, by the seat that carries each desk's sign;
   * sent on arriving and whenever it changes.
   */
  | { t: 'orca.links'; floor: string; desks: Record<string, OrcaLink[]> }
  /** A desk's worktree in Orca: its comment and whether it is unread. */
  | { t: 'orca.desk'; deskId: string; comment: string; unread: boolean }
  /**
   * A task being started: `creating` (Orca makes the worktree), `created` (the agent is starting),
   * `ready` (its figure sat down at `deskId` on `floor`), `failed` (with a reason).
   */
  | { t: 'orca.create'; reqId: string; phase: 'creating' | 'created' | 'ready' | 'failed'; error?: string; floor?: string; deskId?: string };
