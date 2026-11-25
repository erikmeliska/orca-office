// The bridge's link to Orca (orca-office, not agent-office): whether the Orca plugin is connected,
// and the office's light control over Orca (M3, design #14).

import type { WorkerStatus } from './workers.js';

/** What a figure is in Orca, for what the office can do with it (WorkerInfo.orca). */
export interface OrcaWorkerInfo {
  /** A terminal agent on this machine: its live terminal opens in the office and takes typing. Chat agents and agents on other hosts have none. */
  terminal: boolean;
  /** On another host (a paired environment): shown, but the office can't act on it. */
  remote: boolean;
  /** An Orca bot (Staff floor, M5): its name; clicking it opens its chats, where you can write to it. */
  bot?: string;
  /** Its worktree's name and branch (M6 A5): what you think in, rather than a made-up name. */
  worktree?: string;
  branch?: string;
  /**
   * While it needs you (M7 B1): Orca's `blocked` is a permission prompt (the banner offers
   * Yes / Always / No), `waiting` a question (a line of text answers it).
   */
  asks?: OrcaAsks;
  /** When Orca last said anything about it: a state, a tool hook, a new last message (M7 B5, stuck?). */
  quietSince?: number;
  /** Its worktree's Kanban status in Orca (`workspaceStatus`, M7 B10): "in-progress", "in-review", … */
  kanban?: string;
  /** Its last turn ended in a failure (Orca's `mainAgent.outcome`, M7 B2): a red "failed" instead of done. */
  failed?: boolean;
}

/**
 * Steering an agent from its desk (M7 B13), only on an explicit click: Esc to interrupt it, or one of
 * the office's own short prompts (never your text: that's P). The bridge holds the texts.
 */
export const ORCA_STEERS = ['interrupt', 'summarize', 'continue'] as const;
export type OrcaSteer = (typeof ORCA_STEERS)[number];
export const ORCA_STEER_PROMPTS: Record<Exclude<OrcaSteer, 'interrupt'>, string> = {
  summarize: 'Pause for a moment and summarize where you are: what is done, what is left, and anything blocking you. Then wait for me.',
  continue: 'Continue.',
};

/** What a figure that needs you is stopped on (M7 B1). */
export type OrcaAsks = 'permission' | 'question';

/** The answers to a permission prompt the office can give (M7 B1); the bridge finds the key on the screen. */
export const ORCA_ANSWERS = ['yes', 'always', 'no'] as const;
export type OrcaAnswer = (typeof ORCA_ANSWERS)[number];

/** Agents the office can start in a new workspace; Orca's plugin worker allows the same (plugin/src/worker.ts). */
export const ORCA_AGENTS = ['claude', 'codex', 'antigravity', 'opencode', 'copilot', 'cursor', 'pi'] as const;
export type OrcaAgent = (typeof ORCA_AGENTS)[number];

/** How the New task picker names an agent; Orca's id where it differs from the CLI people know. */
export const ORCA_AGENT_LABELS: Partial<Record<OrcaAgent, string>> = { antigravity: 'agy (Antigravity)' };

/** Bounds the bridge holds the page's messages to (and the worker its calls). */
export const ORCA_LIMITS = { send: 4096, prompt: 8000, comment: 2000, name: 60 } as const;

export type OrcaActionKind = 'type' | 'open' | 'read' | 'comment' | 'create' | 'terminal' | 'chat' | 'bot' | 'answer' | 'steer' | 'resume';

/** One entry of a chat agent's conversation, read-only (`orca agent read`): a message, or a tool it used. */
export type OrcaChatEntry = { role: 'user' | 'assistant'; text: string; shortened?: boolean; mail?: OrcaMailFrom } | { tool: string; state: string | null };

/**
 * A user turn that is Orca mail (`orchestration send`): who sent it, its header taken off the text.
 * `office` is the office itself (a message written in the bot panel, M5).
 */
export type OrcaMailFrom = { office: true } | { office: false; from: string };

/** Entries a chat panel shows (the newest), and the longest text an entry carries. */
export const ORCA_CHAT = { entries: 50, text: 20_000 } as const;

/**
 * One of a bot's chats (`orca bot chats`, M5): its id (the chat's Orca session), its title cut to
 * ORCA_BOT_CHAT_TITLE (private, design #20), whether it is the bot's Home Chat, its last activity.
 */
export interface OrcaBotChat {
  id: string;
  title: string | null;
  home: boolean;
  lastActivityAt: number | null;
}

/** The longest chat title the page gets, and how many of a bot's chats it lists (newest first). */
export const ORCA_BOT_CHAT_TITLE = 60;
export const ORCA_BOT_CHATS = 20;
/** What `orca.bot.send` takes as `chatId` to start a new chat on the bot (titled from the message's first line). */
export const ORCA_NEW_CHAT = 'new';

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

/**
 * How a floor's repo-wide board went (v2, #38): `ok`; `loading` (first read running); `missing`
 * (the forge's CLI isn't installed); `auth` (it isn't logged in); `failed` (it errored or timed out);
 * `no_remote` (no GitHub/GitLab remote).
 */
export type OrcaForgeStatus = 'ok' | 'loading' | 'missing' | 'auth' | 'failed' | 'no_remote';

/** An open issue or pull/merge request on a floor's forge; `worktree`: some worktree works on it (linked in Orca, or on its branch). */
export interface OrcaForgeItem {
  kind: 'issue' | 'pr' | 'mr';
  /** "#12" or "!7". */
  ref: string;
  number: number;
  /** Cut with toBubble to ORCA_LINK_TITLE. */
  title: string;
  /** https only. */
  url?: string;
  draft?: boolean;
  worktree: boolean;
  /** A pull request's checks (M7 B4): all passed, any failed, some still running, or none. */
  ci?: OrcaCi;
  /** Lines added and removed (M7 B4). */
  additions?: number;
  deletions?: number;
}

export type OrcaCi = 'passing' | 'failing' | 'pending' | 'none';

/**
 * A floor's repo-wide board (v2, design #17, #38), read through the bridge's ForgeAdapter (`gh`,
 * `glab`): open issues, open pull/merge requests and the queue (those no worktree works on yet).
 */
export interface OrcaForgeBoard {
  provider: 'github' | 'gitlab' | null;
  /** `owner/name`. */
  repo: string | null;
  status: OrcaForgeStatus;
  /** What the board says when it isn't `ok` (e.g. "`gh` isn't logged in: run `gh auth login` …"). */
  note?: string;
  issues: OrcaForgeItem[];
  pulls: OrcaForgeItem[];
  queue: OrcaForgeItem[];
  /** When the forge was read (0: not yet). */
  fetchedAt: number;
}

/**
 * A project room's board (#29, #30, design #10, #27): an orchestration Run (or a worktree lineage
 * across repos). Objective, task titles and gate questions are private: cut to 60 by the bridge.
 */
export interface OrcaProject {
  source: 'run' | 'lineage';
  objective: string | null;
  /** Who sits at the head of the table; null when Orca doesn't say. */
  coordinator: { name: string; bot: boolean } | null;
  tasks: { id: string; title: string | null; status: 'pending' | 'ready' | 'dispatched' | 'in_progress' | 'completed' | 'failed' | 'blocked' }[];
  /** Decision gates waiting for you; `seat` is the desk "Open in Orca" opens (null: none to open). */
  gates: { id: string; question: string | null; options: string[]; seat: string | null }[];
  /** A lineage room's worktrees, by name. */
  members: string[];
}

/**
 * Something anywhere in the building waiting for you (M6, roadmap A1/A2): an agent stopped on a
 * question or a permission, or an orchestration Run's decision gate. Longest waiting first.
 */
export interface OrcaWaiting {
  /** Stable: the figure's id, or `gate:<id>`. */
  key: string;
  kind: 'agent' | 'gate';
  floor: string;
  floorName: string;
  /** The figure to go to; null for a gate. */
  workerId: string | null;
  /** Its desk on that floor (a gate's: the seat "Open in Orca" opens); null when there is none. */
  deskId: string | null;
  /** Who: the worktree (or bot), or "Decision" for a gate. */
  name: string;
  /** What it asks, already a short bubble (≤120); null when Orca doesn't say. */
  ask: string | null;
  /** Since when it has waited (ms). */
  since: number;
  /** A permission prompt or a question (M7 B1); absent for a gate. */
  asks?: OrcaAsks;
  /** A terminal agent on this machine: the banner can answer it without opening the terminal (M7 B1). */
  terminal?: boolean;
}

/** One figure of the building's roster (M6 A6): for ⌘K and the Workers panel across floors. */
export interface OrcaRosterWorker {
  id: string;
  name: string;
  status: WorkerStatus;
  deskId: string;
  branch?: string;
  /** Its bubble (≤120), what it's on or asks. */
  summary?: string;
  bot?: boolean;
  /** A terminal agent on this machine: a line can be typed into it (the 2D list's Reply). */
  terminal?: boolean;
  /** Since when it has been in this state (ms). */
  since?: number;
  asks?: OrcaAsks;
  /** When Orca last said anything about it (M7 B5). */
  quietSince?: number;
  /** While working: since when (M7 B5, working for hours). */
  workingSince?: number;
  /** Its worktree's Kanban status (M7 B10). */
  kanban?: string;
  /** Done and nobody has looked yet (Orca's unread dot), for the Command Center's Done / Ended (M7 B3). */
  unread?: boolean;
  /** A chat agent (no terminal) on this machine: Enter shows its conversation (M7 B3). */
  chat?: boolean;
}

/** A floor of the roster: repository floors and the Staff floor (project rooms only mirror them). */
export interface OrcaRosterFloor {
  floor: string;
  name: string;
  workers: OrcaRosterWorker[];
}

export type OrcaClientMsg =
  /** Show the figure's workspace in Orca and focus its terminal (`workerId`), or a desk's worktree (`deskId`). */
  | { t: 'orca.open'; workerId?: string; deskId?: string }
  /**
   * Answer a permission prompt (M7 B1): the bridge reads the figure's terminal, finds the menu and
   * sends the key that picks `choice` (a digit, or the option's own shortcut). Nothing else is typed.
   * `since` is the wait the page showed (OrcaWaiting.since): a prompt that came up after it is refused
   * (`prompt_changed`), so a click never approves something the page didn't show.
   */
  | { t: 'orca.answer'; workerId: string; choice: OrcaAnswer; since: number }
  /** Steer a terminal agent (M7 B13): Esc, or one of ORCA_STEER_PROMPTS, typed into its terminal. */
  | { t: 'orca.steer'; workerId: string; steer: OrcaSteer }
  /** Resume the last session of the desk's worktree (M7 B13): Orca's `agent.resume` in a new terminal there. */
  | { t: 'orca.resume'; deskId: string }
  /** Mark the desk's worktree read in Orca (clears its unread dot). */
  | { t: 'orca.read'; deskId: string }
  /** Set the desk's worktree comment in Orca ('' clears it). */
  | { t: 'orca.comment'; deskId: string; comment: string }
  /** Ask for the desk's worktree comment and unread state; answered with `orca.desk`. */
  | { t: 'orca.desk'; deskId: string }
  /** Open a chat agent's conversation (read-only) in a panel; `orca.chat` comes while it's open. */
  | { t: 'orca.chat.open'; workerId: string }
  | { t: 'orca.chat.close'; workerId: string }
  /** Open a bot's chats (M5): `orca.bot` comes with the list (and again when it changes) while it's open. */
  | { t: 'orca.bot.open'; workerId: string }
  /** Show one of the open bot's chats: `orca.chat` (with its `chatId`) comes while it's shown. */
  | { t: 'orca.bot.chat'; workerId: string; chatId: string }
  | { t: 'orca.bot.close'; workerId: string }
  /** Write to the bot: into `chatId`, or ORCA_NEW_CHAT for a new chat. How it goes comes as `orca.bot.sent`. */
  | { t: 'orca.bot.send'; workerId: string; reqId: string; chatId: string; text: string }
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
  | { t: 'orca.chat'; workerId: string; state: string | null; entries: OrcaChatEntry[]; limited: boolean; chatId?: string }
  /** The open bot's chats (M5), newest first, at most ORCA_BOT_CHATS. */
  | { t: 'orca.bot'; workerId: string; bot: string; chats: OrcaBotChat[] }
  /**
   * A message to a bot (`orca.bot.send`): `sending`, then `sent` (with the chat it went to, once
   * known: a new chat's id is learned from the bot's chat list) or `failed` with a short reason.
   */
  | { t: 'orca.bot.sent'; workerId: string; reqId: string; phase: 'sending' | 'sent' | 'failed'; chatId?: string; error?: string }
  /**
   * What Orca links to the desks of the page's floor, by the seat that carries each desk's sign;
   * sent on arriving and whenever it changes.
   */
  | { t: 'orca.links'; floor: string; desks: Record<string, OrcaLink[]> }
  /** The repo-wide board of the page's floor (#38); null on floors without a repository. Sent on arriving and on change. */
  | { t: 'orca.forge'; floor: string; board: OrcaForgeBoard | null }
  /** The board of the project room the page is in (#29, #30); null when it isn't in one. Sent on arriving and on change. */
  | { t: 'orca.project'; floor: string; project: OrcaProject | null }
  /** A delivery to animate on the page's floor (#34): seat to seat; null = up to the roof or down from it. */
  | { t: 'orca.handoff'; from: string | null; to: string | null; kind: 'dispatch' | 'ask' | 'reply' | 'worker_done' | 'escalation'; subject: string | null }
  /** Every figure on every floor (M6 A6), for ⌘K and the Workers panel. Sent after `welcome` and on change. */
  | { t: 'orca.roster'; floors: OrcaRosterFloor[] }
  /** Everything in the building waiting for you, longest first (M6 A1/A2). Sent after `welcome` and on change. */
  | { t: 'orca.waiting'; items: OrcaWaiting[] }
  /** A desk's worktree in Orca: its comment and whether it is unread. */
  | { t: 'orca.desk'; deskId: string; comment: string; unread: boolean }
  /**
   * A task being started: `creating` (Orca makes the worktree), `created` (the agent is starting),
   * `ready` (its figure sat down at `deskId` on `floor`), `failed` (with a reason).
   */
  | { t: 'orca.create'; reqId: string; phase: 'creating' | 'created' | 'ready' | 'failed'; error?: string; floor?: string; deskId?: string };
