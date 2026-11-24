/**
 * What Orca hands the bridge, as far as the office reads it: the plugin's snapshot, events and hooks
 * (plugin/src/worker.ts) and the CLI's JSON (`orca agent list`, `orca bot list`). Shapes from
 * docs/spike-m0.md and Orca's host API 1.10 typings. Everything is parsed defensively: a field
 * that isn't what it should be is dropped, never trusted.
 *
 * Privacy (design #20): `lastAssistantMessage` is cut to a bubble (toBubble) the moment it is read
 * and the original is dropped; agent titles are never read at all.
 */
import { toBubble } from '@orca-office/shared';
import { ORCA_CHAT, type OrcaChatEntry } from '@orca-office/shared/office/protocol/orca';

export type OrcaState = 'working' | 'blocked' | 'waiting' | 'done';

/** A row of the plugin's `workspace.list({ includeStatus: true })`. */
export interface OrcaWorkspace {
  id: string;
  kind: 'worktree' | 'folder';
  /** Orca's display name of the worktree (or folder). */
  name: string;
  project: string | null;
  /** Orca's project id (what `workspace.create` takes), for a worktree. */
  projectId: string | null;
  path: string;
  branch: string | null;
  hostId: string | null;
  state: string;
  unread: boolean;
  lastActivityAt: number | null;
}

/** An agent session from `orca agent list --json` (one host). */
export interface CliAgent {
  paneKey: string;
  /** Orca's session id (`orca agent read <id>` reads its conversation). */
  sessionId: string | null;
  kind: 'chat' | 'terminal';
  agent: string | null;
  state: OrcaState;
  /** `<repoId>::<path>` for a worktree, `folder:<id>` for a folder. */
  worktreeId: string;
  /** The workspace's name ("main", a worktree name, or a bot's name). */
  workspace: string;
  repo: string | null;
  hostId: string;
  /** Already cut to a bubble (≤120 chars, one line); the original is never kept. */
  bubble: string | null;
  updatedAt: number;
}

export interface CliAgentList {
  agents: CliAgent[];
  /** Each host this list left out (paired environments): its host id, and the name `--environment` takes. */
  environments: { hostId: string; name: string }[];
}

/** An `agent.status.changed` event from the plugin. */
export interface StatusEvent {
  paneKey: string;
  workspaceListId: string | null;
  terminalId: string | null;
  state: OrcaState;
  at: number;
}

/** An `agent.tool.after` hook from the plugin: tool name and, worked out in the worker, what it looks like. */
export interface ToolHook {
  terminalId: string | null;
  workspaceId: string | null;
  tool: string;
  /** 'read' | 'edit' | 'test' | 'web', when the worker could tell. */
  action: string | null;
  /** A test or build run whose output says it failed. */
  failed: boolean;
  /** The tool call's id, which ties a subagent's start (agent.tool.before) to its end. */
  callId: string | null;
  at: number;
}

export interface OrcaBot {
  id: string;
  name: string;
  agent: string | null;
  paused: boolean;
  specialty: string | null;
}

const STATES = new Set(['working', 'blocked', 'waiting', 'done']);

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function state(v: unknown): OrcaState | null {
  return typeof v === 'string' && STATES.has(v) ? (v as OrcaState) : null;
}

/** The CLI wraps results as `{ ok, result }`; older builds print the result itself. */
function result(json: unknown): Record<string, unknown> | null {
  const o = obj(json);
  return obj(o?.result) ?? o;
}

export function parseWorkspaces(snapshot: unknown): OrcaWorkspace[] {
  const rows = obj(snapshot)?.workspaces;
  if (!Array.isArray(rows)) return [];
  const out: OrcaWorkspace[] = [];
  for (const r of rows) {
    const o = obj(r);
    const id = str(o?.id);
    const kind = o?.kind === 'worktree' || o?.kind === 'folder' ? o.kind : null;
    if (!o || !id || !kind) continue;
    const st = obj(o.status);
    out.push({
      id,
      kind,
      name: str(o.name) ?? id,
      project: str(o.project),
      projectId: str(o.projectId),
      path: str(o.path) ?? '',
      branch: str(o.branch),
      hostId: str(o.hostId),
      state: str(st?.state) ?? 'inactive',
      unread: st?.unread === true,
      lastActivityAt: num(st?.lastActivityAt),
    });
  }
  return out;
}

export function parseAgentList(json: unknown, hostFallback = 'local'): CliAgentList {
  const r = result(json);
  const out: CliAgent[] = [];
  for (const a of Array.isArray(r?.agents) ? r.agents : []) {
    const o = obj(a);
    const paneKey = str(o?.paneKey);
    const st = state(o?.state);
    if (!o || !paneKey || !st) continue;
    out.push({
      paneKey,
      sessionId: str(o.orcaSessionId),
      kind: o.kind === 'terminal' ? 'terminal' : 'chat',
      agent: str(o.agent),
      state: st,
      worktreeId: str(o.worktreeId) ?? '',
      workspace: str(o.workspace) ?? '',
      repo: str(o.repo),
      hostId: str(o.hostId) ?? hostFallback,
      bubble: toBubble(typeof o.lastAssistantMessage === 'string' ? o.lastAssistantMessage : null),
      updatedAt: num(o.updatedAt) ?? 0,
    });
  }
  const environments: { hostId: string; name: string }[] = [];
  const scope = obj(r?.hostScope);
  for (const s of Array.isArray(scope?.omittedHostSelectors) ? scope.omittedHostSelectors : []) {
    const m = /^--environment\s+(\S+)$/.exec(str(obj(s)?.selector) ?? '');
    const hostId = str(obj(s)?.hostId);
    if (m && hostId) environments.push({ hostId, name: m[1]! });
  }
  return { agents: out, environments };
}

export function parseStatusEvent(payload: unknown, at: number): StatusEvent | null {
  const o = obj(payload);
  const paneKey = str(o?.paneKey);
  const st = state(o?.state);
  if (!o || !paneKey || !st) return null;
  return { paneKey, workspaceListId: str(o.workspaceListId), terminalId: str(o.terminalId), state: st, at };
}

export function parseToolHook(payload: unknown, at: number): ToolHook | null {
  const o = obj(payload);
  const tool = str(o?.tool);
  if (!o || !tool) return null;
  return {
    terminalId: str(o.terminalId),
    workspaceId: str(o.workspaceId),
    tool: tool.slice(0, 64),
    action: str(o.action),
    failed: o.failed === true,
    callId: str(o.callId)?.slice(0, 128) ?? null,
    at,
  };
}

export function parseBots(json: unknown): OrcaBot[] {
  const r = result(json);
  const out: OrcaBot[] = [];
  for (const b of Array.isArray(r?.bots) ? r.bots : []) {
    const o = obj(b);
    const id = str(o?.id);
    const name = str(o?.name);
    if (!o || !id || !name) continue;
    out.push({ id, name: name.slice(0, 32), agent: str(o.agent), paused: o.paused === true, specialty: toBubble(str(o.specialty), 80) });
  }
  return out;
}

/** The path in a CLI `worktreeId` (`<repoId>::<path>`), or null for a folder. */
export function worktreePath(worktreeId: string): string | null {
  const i = worktreeId.indexOf('::');
  return i < 0 ? null : worktreeId.slice(i + 2);
}

/** A terminal from `orca terminal list --json`: its handle and the pane it is in (`paneKey` = `<tabId>:<leafId>`). */
export interface CliTerminal {
  handle: string;
  paneKey: string;
}

/**
 * `orca terminal list --json` (this machine): which terminal handle each pane has, so a figure that
 * has sent no status event since the bridge started still gets its terminal. Titles and previews
 * are never read.
 */
export function parseTerminals(json: unknown): CliTerminal[] {
  const r = result(json);
  const out: CliTerminal[] = [];
  for (const t of Array.isArray(r?.terminals) ? r.terminals : []) {
    const o = obj(t);
    const handle = str(o?.handle);
    const tab = str(o?.tabId);
    const leaf = str(o?.leafId);
    if (!handle || !/^term_[A-Za-z0-9_-]{1,120}$/.test(handle) || !tab || !leaf) continue;
    if (o?.executionHostId !== undefined && o.executionHostId !== 'local') continue;
    out.push({ handle, paneKey: `${tab}:${leaf}` });
  }
  return out;
}

/** What `orca agent read --json` says of a conversation: kept only to send to the open panel. */
export interface CliConversation {
  state: string | null;
  entries: OrcaChatEntry[];
  limited: boolean;
}

/**
 * `orca agent read <id> --json`: messages (user / assistant text, cut to ORCA_CHAT.text) and the
 * names of tools used; anything else is dropped. Never logged or stored: it goes to the one panel.
 */
export function parseConversation(json: unknown): CliConversation | null {
  const r = result(json);
  if (!r || !Array.isArray(r.entries)) return null;
  const entries: OrcaChatEntry[] = [];
  for (const e of r.entries.slice(-ORCA_CHAT.entries)) {
    const o = obj(e);
    if (o?.kind === 'message' && (o.role === 'user' || o.role === 'assistant') && typeof o.text === 'string') {
      const cut = o.text.length > ORCA_CHAT.text;
      entries.push({ role: o.role, text: cut ? o.text.slice(0, ORCA_CHAT.text) : o.text, ...(cut || o.shortened === true ? { shortened: true } : {}) });
    } else if (o?.kind === 'tool' && str(o.name)) entries.push({ tool: str(o.name)!.slice(0, 64), state: str(o.state)?.slice(0, 24) ?? null });
  }
  return { state: str(r.state)?.slice(0, 24) ?? null, entries, limited: r.limited === true };
}
