/**
 * The Office API, v1 (docs/api.md): what the bridge knows about Orca, for a local process (the first
 * consumer is Maestro). Read-only. These types are the contract: copy them, or generate from them.
 *
 *   GET /api/v1/health    no token; no private data
 *   GET /api/v1/snapshot  ApiSnapshot
 *   GET /api/v1/events    Server-Sent Events: `snapshot` (ApiSnapshot) on connect, then `changed`
 *                         (ApiChanged) on every change and `heartbeat` (ApiHeartbeat) every ~15 s
 *
 * Every time is ms since the epoch. Ids are stable for as long as Orca keeps the thing they name.
 * Fields may be added within v1; nothing is removed or changes meaning without a new version.
 *
 * Private text (design #20): `question`, `title`, a Run's `objective`, task titles, gate questions and
 * options and worktree comments are given in full here, and only here: to a local process that holds
 * the API token. The bridge keeps them in memory only and never logs or writes them.
 */

export const API_VERSION = 1 as const;

/** The base path of this version. */
export const API_BASE = '/api/v1';

/** An agent's state as Orca says it (done is held back ~1 s, as in the office). */
export type ApiAgentState = 'working' | 'blocked' | 'waiting' | 'done';

/** `floors` lists every Orca project, the shown ones first (see ApiFloor.shown). */
export interface ApiSnapshot {
  version: typeof API_VERSION;
  /** When this snapshot was made. */
  at: number;
  /** Bumped whenever the snapshot's content changes (see `fingerprint`); what `changed` events carry. */
  rev: number;
  /** A digest of the content (everything but `at`, `rev` and `orca.lastSnapshotAt`): equal digests, equal content. */
  fingerprint: string;
  orca: {
    /** The Orca plugin is connected to the bridge (Orca is running). */
    connected: boolean;
    /** When the plugin last sent a snapshot of Orca's workspaces; null before the first. */
    lastSnapshotAt: number | null;
  };
  floors: ApiFloor[];
  /**
   * Whether `worktrees[].servers` is read: 'loading' until the first read since someone started
   * looking (the bridge reads `orca ports` only while a page, an event stream or a snapshot within
   * the last 2 min looks), then 'ok'. While 'loading', empty `servers` means "not known yet".
   */
  serversStatus: ApiLoadStatus;
  worktrees: ApiWorktree[];
  agents: ApiAgent[];
  bots: ApiBot[];
  runs: ApiRun[];
  /** The providers' plan limits (#70), as the office's Usage panel shows them; null in stub mode. */
  usage: ApiUsage | null;
  rooms: ApiRoom[];
}

/** A repository (an Orca project), or the folders, or a remote repository Orca has no project for. */
export interface ApiFloor {
  /** The office's floor id (`f-…`), stable across renames for an Orca project. */
  id: string;
  /** Orca's project id; null for folders and floors by name. */
  projectId: string | null;
  name: string;
  /** The repository's own checkout (its main worktree); '' when Orca lists none. */
  dir: string;
  /**
   * The 3D office shows this floor: Orca has one of its workspaces open, or an agent works there.
   * Orca knows every project ever added (often 100+); filter on this for what is in use now.
   */
  shown: boolean;
  /** Its workspaces Orca lists (ApiWorktree), open or not. */
  worktrees: number;
  /** Of those, the ones Orca has open. */
  openWorktrees: number;
  /** Agents on this floor (ApiAgent). */
  agents: number;
  needsYou: number;
  working: number;
  stuck: number;
  done: number;
}

export type ApiLinkProvider = 'github' | 'gitlab' | 'linear' | 'jira' | 'bitbucket' | 'azure' | 'gitea' | 'other';

/** What Orca links to a worktree: a PR, MR, issue or work item. */
export interface ApiLink {
  provider: ApiLinkProvider;
  kind: 'pr' | 'mr' | 'issue' | 'item';
  /** "#128", "!17", "WEB-311". */
  ref: string;
  /** https only. */
  url?: string;
  /** Its title, cut to 80 characters. */
  title?: string;
}

/** A dev server in a worktree (`orca ports`). */
export interface ApiServer {
  port: number;
  host: string;
  pid: number;
  /** The command, with anything that looks like a secret left out. */
  command: string;
  url: string;
  /** The page's title, when it has one. */
  title?: string;
  since: number;
}

export interface ApiWorktree {
  /** Orca's workspace id (what the plugin's `workspace.list` gives); `<host>|<worktreeId>|<name>` for one only a remote agent names. */
  id: string;
  /** `<repoId>::<path>`, the id the CLI and orchestration use; null when Orca's worktree list doesn't have it. */
  orcaWorktreeId: string | null;
  floorId: string;
  kind: 'worktree' | 'folder';
  name: string;
  branch: string | null;
  path: string;
  /** 'local', or the remote host. */
  hostId: string;
  /** Orca has it open (it has a desk in the office). */
  open: boolean;
  /** Its Kanban status in Orca (`workspaceStatus`): 'todo', 'in-progress', 'in-review'…, or null. */
  workspaceStatus: string | null;
  unread: boolean;
  lastActivityAt: number | null;
  /** The worktree's comment in Orca (private), or null. */
  comment: string | null;
  links: ApiLink[];
  servers: ApiServer[];
  /** The repository's own checkout rather than a worktree Orca added. */
  isMain: boolean;
  parentId: string | null;
}

/** What a working agent last did, from Orca's tool hooks (local terminal agents only). */
export interface ApiAction {
  /** The tool's name: "Edit", "Bash"… */
  tool: string;
  /** What the office acts out: 'read' | 'edit' | 'test' | 'web' | 'failing' | …, when it could tell. */
  kind: string | null;
  at: number;
}

export interface ApiAgent {
  /** Stable for the session: the office's figure id (`a-…`). */
  id: string;
  /** The worktree it works in (ApiWorktree.id). */
  worktreeId: string;
  floorId: string;
  /** The agent CLI: 'claude', 'codex', … (Orca's name for it), or null. */
  agent: string | null;
  surface: 'terminal' | 'chat';
  state: ApiAgentState;
  /** Waiting for you: blocked (a permission) or waiting (a question). */
  needsYou: boolean;
  /** 'permission' for blocked, 'question' for waiting; null otherwise. */
  asks: 'permission' | 'question' | null;
  /** Working, but Orca has been quiet about it ≥15 min, or it has worked ≥4 h at a stretch (a guess). */
  stuck: boolean;
  stuckWhy: 'quiet' | 'long' | null;
  /** When it went into its current state. */
  since: number;
  /** When Orca last said anything about it (a state, a hook, a newer row). */
  quietSince: number;
  /** Its session's title in Orca (private; generated from the first prompt), or null. */
  title: string | null;
  /** While it waits for you: its last words in full, as Orca gives them (private); null otherwise. */
  question: string | null;
  /** Its last words, one line, ≤120 characters (what the office's speech bubble shows). */
  bubble: string | null;
  lastAction: ApiAction | null;
  /** Claude Code subagents running now. */
  helpers: number;
  /** Its last turn ended in a failure. */
  failed: boolean;
  /** Orca's session id (`orca agent read <id>`). */
  orcaSessionId: string | null;
  /** The provider's own session id, when Orca gives one. */
  sessionId: string | null;
  /** Orca's pane key. */
  paneKey: string;
  /** Its terminal handle (local terminal agents), or null. */
  terminalId: string | null;
  hostId: string;
}

export type ApiBotState = 'working' | 'needs_input' | 'idle' | 'paused';

export interface ApiBotChat {
  /** The chat's Orca session id. */
  id: string;
  state: ApiAgentState;
  lastActivityAt: number;
}

export interface ApiBot {
  id: string;
  name: string;
  agent: string | null;
  specialty: string | null;
  state: ApiBotState;
  chats: ApiBotChat[];
}

export type ApiTaskStatus = 'pending' | 'ready' | 'dispatched' | 'in_progress' | 'completed' | 'failed' | 'blocked';

export interface ApiRunTask {
  id: string;
  status: ApiTaskStatus;
  /** In full (private). */
  title: string | null;
}

export interface ApiRunGate {
  id: string;
  taskId: string | null;
  /** In full (private). */
  question: string | null;
  /** In full (private). */
  options: string[];
}

export interface ApiRunWorker {
  dispatchId: string;
  taskId: string | null;
  state: string | null;
  /** `<repoId>::<path>` (ApiWorktree.orcaWorktreeId), or null. */
  worktree: string | null;
  hostId: string;
}

/** Who coordinates a Run or a room: a bot, an agent, or (lineage) the root worktree. */
export type ApiCoordinator =
  | { kind: 'bot'; botId: string; name: string }
  | { kind: 'agent'; agentId: string; name: string }
  | { kind: 'worktree'; worktree: string; name: string };

export interface ApiRun {
  id: string;
  /** In full (private). */
  objective: string | null;
  /** It has open tasks or a pending gate, or changed in the last 2 h (the office shows its room). */
  live: boolean;
  updatedAt: number;
  tasks: ApiRunTask[];
  /** Pending gates: decisions waiting for you. */
  gates: ApiRunGate[];
  workers: ApiRunWorker[];
  coordinator: ApiCoordinator | null;
}

export interface ApiUsageWindow {
  label: string;
  /** 0–100. */
  pct: number;
  resetsAt?: number;
}

export interface ApiUsageProvider {
  id: string;
  name: string;
  status: string;
  plan?: string;
  windows: ApiUsageWindow[];
  resets?: number;
  at: number;
}

/** 'loading': not read yet (fields are empty for now); 'ok': read. */
export type ApiLoadStatus = 'loading' | 'ok';

export interface ApiUsage {
  /** 'loading' while a provider with a CLI has not been read yet; each provider has its own `status` too. */
  status: ApiLoadStatus;
  providers: ApiUsageProvider[];
  at: number;
}

/** A project room on the roof: a live Run, or a worktree family across repositories (lineage). */
export interface ApiRoom {
  /** The office's floor id (`p-…`). */
  id: string;
  source: 'run' | 'lineage';
  runId: string | null;
  /** The Run's objective in full (private), or the family's name. */
  name: string;
  coordinator: ApiCoordinator | null;
  /** The members' worktrees (`<repoId>::<path>`), in seat order. */
  members: string[];
}

export interface ApiHealth {
  ok: true;
  version: typeof API_VERSION;
  orca: { connected: boolean };
}

/** SSE `changed`: the content is now at `rev`; fetch /api/v1/snapshot unless you have it. */
export interface ApiChanged {
  rev: number;
  fingerprint: string;
  at: number;
}

export interface ApiHeartbeat {
  rev: number;
  at: number;
}

/** An error body: 401 `unauthorized`, 403 `origin`, 421 `host`, 429 `rate`, 404 `not_found`, 405 `method`, 503 `busy`. */
export interface ApiError {
  error: string;
}
