/**
 * The live office (M2, #16): Orca's workspaces and agents mapped onto the building.
 *
 *   floor  = repository: the worktree's Orca project, keyed by its id (two repos called the same are two
 *            floors), its directory the repository's own checkout; folders, and a remote agent's repo
 *            Orca has no project for, by name
 *   desk   = worktree: 1–4 seats side by side in one desk cluster, "+N" on its sign past 4
 *   figure = agent session (terminal or chat), on any host; a remote host is a tag on its card
 *   Staff  = a floor of its own for Orca's bots, one desk each
 *
 * States: working → working; blocked / waiting → needs you; done → done (resting); a worktree Orca
 * has open without an agent → an empty desk with its sign. Repeated states change nothing, and done
 * waits DONE_DEBOUNCE_MS so a launch's done/working flicker never shows (spike-m0.md).
 *
 * Pure: inputs come in through the apply* methods with the time, `building()` says what the office
 * shows. Nothing here is stored or logged; agent text arrives already cut to a bubble (orca.ts).
 */
import { FAILS_TO_DESPAIR, toolAction } from '@orca-office/shared/office/actions';
import { isAgentProvider } from '@orca-office/shared/office/providers';
import { cleanLabel, type FloorPlan } from '@orca-office/shared/office/floorplan';
import { FLOOR_PALETTES } from '@orca-office/shared/office/floors';
import { BEANBAGS, DESKS, WING_DESKS } from '@orca-office/shared/office/layout';
import type { FloorInfo, ServiceInfo, WorkerAction, WorkerInfo, WorkerStatus } from '@orca-office/shared/office/protocol';
import type { OrcaLink, OrcaProject, OrcaRosterFloor, OrcaWaiting } from '@orca-office/shared/office/protocol/orca';
import { pinsText, type OrcaWorktree } from './worktrees.js';
import type { PortRow } from './ports.js';
import { isLive, type HandoffKind, type InboxMessage, type OrcaRun, type RunGate, type RunTask, type TaskStatus } from './runs.js';
import { RECENT_MS } from './runs-poller.js';
import type { ForgeTarget } from './forge.js';
import { worktreePath, type CliAgent, type CliTerminal, type OrcaBot, type OrcaState, type OrcaWorkspace, type StatusEvent, type ToolHook } from './orca.js';

export const DONE_DEBOUNCE_MS = 1_000;
/** An agent seen only in an event, not (yet) in `orca agent list`, is kept this long. */
export const PROVISIONAL_MS = 20_000;
/** Seats a desk shows; more agents than this at one worktree are "+N" on its sign. */
export const MAX_SEATS = 4;
/** A tool's action is acted out this long after its hook, unless another one comes first. */
export const ACTION_MS = 12_000;
export const STAFF_FLOOR = 'staff';
/** A subagent nobody saw end is let go after this long. */
export const HELPER_MAX_MS = 30 * 60_000;
const LOCAL = 'local';
/** Quiet this long, an event is news to the pages (a figure may be showing "stuck?", B5). */
const QUIET_NEWS_MS = 60_000;

const WORKER_COLORS = ['#ef476f', '#118ab2', '#ffd166', '#06d6a0', '#8338ec', '#f78c6b', '#4f86f7', '#073b4c', '#e76f51', '#2a9d8f', '#9b5de5', '#f15bb5'];
const NAMES = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Fa', 'Gu', 'Ha', 'Ivo', 'Jo', 'Kai', 'Lu', 'Mo', 'Nia', 'Oto', 'Pia', 'Rae', 'Sol', 'Tea', 'Uma', 'Vik', 'Wes', 'Xan', 'Yul', 'Zoe'];

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A bot's figure id: stable, from its Orca id. */
export function botWorkerId(b: { id: string }): string {
  return `bot-${hash(b.id).toString(36)}`;
}

/** Desk clusters: the room's four pods of four desks side by side, then the back office's four. */
const CLUSTERS: string[][] = [...chunk(DESKS.map((d) => d.id), 4), WING_DESKS.map((d) => d.id)];
const WING_IDS = new Set(WING_DESKS.map((d) => d.id));
const BEANBAG_IDS = BEANBAGS.map((d) => d.id);
/** The Staff floor's seats: one per cluster first, so each bot has its own corner. */
const STAFF_SEATS = [...CLUSTERS.map((c) => c[0]!), ...CLUSTERS.flatMap((c) => c.slice(1)), ...BEANBAG_IDS];

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

interface AgentRec {
  paneKey: string;
  /** The desk (worktree) it sits at: a workspace.list id, or `<host>|<worktreeId>` for a remote one. */
  deskKey: string;
  /** Its floor's key (floorKeyOf). */
  floor: string;
  kind: 'chat' | 'terminal';
  agent: string | null;
  hostId: string;
  /** What the office shows, after the done debounce. */
  shown: OrcaState;
  shownSince: number;
  /** A done not shown yet, and since when. */
  pendingDone: number | null;
  bubble: string | null;
  /** Orca's session id, for reading a chat's conversation. */
  sessionId: string | null;
  firstSeen: number;
  /** Seen only in a status event so far; dropped after PROVISIONAL_MS unless the CLI lists it. */
  provisional: boolean;
  lastSeen: number;
  action: WorkerAction | null;
  actionAt: number;
  activity: string | null;
  fails: number;
  workingSince: number | null;
  /** Claude Code subagents (Task/Agent tool) running now, by call id, since when (design #12). */
  helpers: Map<string, number>;
  /** When Orca last said anything about it: a state, a hook, a newer row in `orca agent list` (M7 B5). */
  quietSince: number;
  /** Its row's `updatedAt` as last listed. */
  updatedAt: number;
}

interface DeskRec {
  key: string;
  floor: string;
  name: string;
  hostId: string;
  /** A desk shows even without agents (Orca has it open). */
  open: boolean;
  unread: boolean;
  lastActivityAt: number;
}

/** What one floor shows. */
export interface LiveFloor {
  info: FloorInfo;
  workers: WorkerInfo[];
  plan: FloorPlan;
  /** What Orca links to each desk, by the seat with its sign (#32). */
  links: Record<string, OrcaLink[]>;
  /** The dev servers running in the floor's worktrees (`orca ports`, B7). */
  services: ServiceInfo[];
}

export interface Building {
  floors: LiveFloor[];
  /** The board of each project room, by its floor id (#29, #30). */
  projects: Record<string, ProjectBoard>;
  /** Everything in the building waiting for you, longest first (M6 A1/A2). */
  waiting: OrcaWaiting[];
  /** Every figure by floor, for ⌘K and the Workers panel across floors (M6 A6). */
  roster: OrcaRosterFloor[];
}

/** A project room's board (on the page as `orca.project`): private texts already cut to 60. */
export type ProjectBoard = OrcaProject;

/** A delivery the office animates (#34): from one seat to another on a floor; null = off the floor (the roof, or down from it). */
export interface Handoff {
  floor: string;
  from: string | null;
  to: string | null;
  kind: HandoffKind;
  subject: string | null;
}

interface RoomSeat {
  /** The worktree (`<repoId>::<path>` or a workspace path) whose desk this mirrors. */
  path: string | null;
  name: string;
  status: TaskStatus | null;
  dispatchId: string | null;
  taskId: string | null;
}

interface RoomSpec {
  key: string;
  source: 'run' | 'lineage';
  runId: string | null;
  objective: string | null;
  head: { bot: OrcaBot } | { agent: AgentRec } | { path: string; name: string } | null;
  seats: RoomSeat[];
  tasks: RunTask[];
  gates: RunGate[];
}

const STATUS: Record<OrcaState, WorkerStatus> = { working: 'working', blocked: 'needs_input', waiting: 'needs_input', done: 'done' };
const RANK: Record<OrcaState, number> = { blocked: 0, waiting: 0, working: 1, done: 2 };

export class LiveModel {
  private workspaces = new Map<string, OrcaWorkspace>();
  private byPath = new Map<string, OrcaWorkspace>();
  private agents = new Map<string, AgentRec>();
  /** terminalId → paneKey, from status events (the plugin's ids). */
  private terminals = new Map<string, string>();
  /** paneKey → terminal handle, from `orca terminal list` (this machine). */
  private paneTerminals = new Map<string, string>();
  /** What the office shows by id, as last built: figure id → paneKey, and per floor, seat → desk (workspace key). */
  private workerIds = new Map<string, string>();
  private deskSeats = new Map<string, Map<string, string>>();
  private bots: OrcaBot[] = [];
  /** Bot folders: their chat agents are the bots' own, on the Staff floor (spike-m0.md #5). */
  private botFolders = new Set<string>();
  /** Seats per floor and desk, kept while the desk stays, so figures don't jump about. */
  private seats = new Map<string, Map<string, string[]>>();
  /** What Orca links to each worktree on this machine, by path (`orca worktree list`, #32). */
  private linksByPath = new Map<string, OrcaLink[]>();
  private linksKey = '';
  /** The dev servers by worktree path (`orca ports`, B7). */
  private portsByPath = new Map<string, PortRow[]>();
  /** Every worktree on this machine as `orca worktree list` gave it (lineage, #29 fallback). */
  private worktreeRows: OrcaWorktree[] = [];
  private lineageKey = '';
  /** Orchestration Runs (`orca orchestration …`), and who coordinates each, learned from its mail. */
  private runs: OrcaRun[] = [];
  private runsKey = '';
  /** When each pending decision gate was first seen (Orca gives no time): gate id → ms. */
  private gateSince = new Map<string, number>();
  private coordinators = new Map<string, string>();
  /** Mail and dispatches seen so far (null until the first read: what was there before isn't news). */
  private seenMail: Set<string> | null = null;
  private seenDispatch: Set<string> | null = null;
  private pendingHandoffs: { kind: HandoffKind; subject: string | null; runId: string | null; dispatchId: string | null; toHead: boolean }[] = [];
  /** Where each room's people sit, as last built: by Run (or lineage) key. */
  private roomSeats = new Map<string, { floor: string; head: string; byDispatch: Map<string, string> }>();
  /** Bots away from the Staff floor, coordinating a Run in a project room (#33): bot id → room floor id. */
  private botAway = new Map<string, string>();
  private now = 0;
  /** Bumped on every change the office would show. */
  version = 0;

  // ---- inputs ---------------------------------------------------------------------------------

  /** The plugin's snapshot (every ~10 s and on connect): the worktrees and folders Orca has. */
  applyWorkspaces(rows: OrcaWorkspace[]): void {
    this.workspaces = new Map(rows.map((w) => [w.id, w]));
    this.byPath = new Map(rows.filter((w) => w.kind === 'worktree' && w.path).map((w) => [`${w.hostId ?? LOCAL}|${w.path}`, w]));
    for (const w of rows) if (w.kind === 'folder' && /[/\\]\.orca[/\\]bots[/\\]/.test(w.path)) this.botFolders.add(w.id);
    for (const a of this.agents.values()) {
      const ws = this.workspaces.get(a.deskKey);
      if (ws) a.floor = floorKeyOf(ws);
    }
    this.version++;
  }

  /** `orca agent list --json` for one host: who is there, their state and last words. */
  applyAgents(hostId: string, list: CliAgent[], now: number): void {
    const seen = new Set<string>();
    for (const c of list) {
      if (this.isBotChat(c)) continue;
      seen.add(c.paneKey);
      const desk = this.deskFor(c);
      const prev = this.agents.get(c.paneKey);
      const rec: AgentRec = prev ?? newAgent(c.paneKey, desk.key, desk.floor, now);
      // A newer row or a new last message is Orca saying something about it (B5).
      if (prev && (c.updatedAt > prev.updatedAt || c.bubble !== prev.bubble)) this.heard(prev, c.updatedAt > prev.updatedAt ? Math.min(now, c.updatedAt) : now);
      Object.assign(rec, { deskKey: desk.key, floor: desk.floor, kind: c.kind, agent: c.agent, hostId: c.hostId, bubble: c.bubble, sessionId: c.sessionId, provisional: false, lastSeen: now, updatedAt: c.updatedAt });
      if (!prev) {
        rec.quietSince = c.updatedAt || now;
        rec.shown = c.state;
        rec.shownSince = c.updatedAt || now;
        if (c.state === 'working') rec.workingSince = rec.shownSince;
        this.agents.set(c.paneKey, rec);
      } else this.setState(rec, c.state, now);
    }
    // Gone from its host's list: closed in Orca (a provisional one waits for the CLI to catch up).
    for (const [k, a] of this.agents) {
      if (a.hostId !== hostId || seen.has(k)) continue;
      if (!a.provisional || now - a.firstSeen > PROVISIONAL_MS) this.agents.delete(k);
    }
    if (hostId === LOCAL) this.bumpBotChats(list);
    this.version++;
  }

  /**
   * An `agent.status.changed` event: shown at once (done after the debounce). An agent nobody
   * listed yet is put at its desk straight away; returns true then, so the caller asks the CLI.
   */
  applyStatus(ev: StatusEvent): boolean {
    let rec = this.agents.get(ev.paneKey);
    if (ev.terminalId) this.terminals.set(ev.terminalId, ev.paneKey);
    if (!rec) {
      const ws = ev.workspaceListId ? this.workspaces.get(ev.workspaceListId) : undefined;
      if (!ws || this.botFolders.has(ws.id)) return false;
      rec = newAgent(ev.paneKey, ws.id, floorKeyOf(ws), ev.at);
      Object.assign(rec, { kind: ev.terminalId ? 'terminal' : 'chat', hostId: ws.hostId ?? LOCAL, provisional: true, shown: ev.state, shownSince: ev.at, workingSince: ev.state === 'working' ? ev.at : null });
      this.agents.set(ev.paneKey, rec);
      this.version++;
      return true;
    }
    this.heard(rec, ev.at);
    if (this.setState(rec, ev.state, ev.at)) this.version++;
    return false;
  }

  /** An `agent.tool.before` hook for a subagent tool: a small helper sits by its parent until the call ends. */
  applySubagentStart(h: ToolHook): void {
    const rec = this.agentForHook(h);
    if (rec) this.heard(rec, h.at);
    if (!rec || !h.callId || rec.helpers.has(h.callId)) return;
    rec.helpers.set(h.callId, h.at);
    this.version++;
  }

  /** An `agent.tool.after` hook: what the agent at that terminal acts out. */
  applyHook(h: ToolHook): void {
    const rec = this.agentForHook(h);
    if (rec) this.heard(rec, h.at);
    if (rec && h.callId && rec.helpers.delete(h.callId)) this.version++;
    if (!rec || rec.shown !== 'working') return;
    let action = (h.action as WorkerAction | null) ?? toolAction(h.tool) ?? null;
    if (action === 'test') {
      rec.fails = h.failed ? rec.fails + 1 : 0;
      if (rec.fails >= FAILS_TO_DESPAIR) action = 'failing';
    }
    rec.action = action;
    rec.actionAt = h.at;
    rec.activity = h.tool;
    this.version++;
  }

  /** `orca worktree list --json` (this machine): the links on each worktree. */
  applyWorktrees(list: OrcaWorktree[]): void {
    const local = list.filter((w) => w.hostId === LOCAL);
    this.worktreeRows = local;
    const lineage = JSON.stringify(local.filter((w) => w.parentId || w.childIds.length).map((w) => [w.id, w.parentId, w.childIds]));
    if (lineage !== this.lineageKey) {
      this.lineageKey = lineage;
      this.version++;
    }
    const next = new Map(local.filter((w) => w.links.length).map((w) => [w.path, w.links]));
    const key = JSON.stringify([...next]);
    if (key === this.linksKey) return;
    this.linksKey = key;
    this.linksByPath = next;
    this.version++;
  }

  /** `orca ports --all --json`, already filtered and with safe commands (ports.ts). */
  applyPorts(rows: PortRow[]): void {
    const next = new Map<string, PortRow[]>();
    for (const r of rows) next.set(r.path, [...(next.get(r.path) ?? []), r]);
    this.portsByPath = next;
    this.version++;
  }

  /**
   * What the repo-wide board of a floor needs (#38): one of its local worktrees (git asks it for the
   * remote), and what the repository's worktrees already work on (their branches, Orca's links).
   * Null for a floor with no local worktree (folders, remote-only, rooms, Staff).
   */
  forgeTarget(floor: string): ForgeTarget | null {
    const rowsByPath = new Map(this.worktreeRows.map((r) => [r.path, r]));
    const mine = [...this.workspaces.values()].filter((w) => w.kind === 'worktree' && (w.hostId ?? LOCAL) === LOCAL && w.path && this.floorIdOf(w) === floor);
    if (!mine.length) return null;
    const paths = mine.map((w) => w.path);
    const repoId = paths.map((p) => rowsByPath.get(p)?.repoId).find((r): r is string => !!r) ?? null;
    const rows = repoId ? this.worktreeRows.filter((r) => r.repoId === repoId) : [];
    const dir = this.mainCheckout(floorKeyOf(mine[0]!)) ?? rows[0]?.path ?? paths[0]!;
    const linked = new Set<string>();
    for (const r of rows) for (const l of r.links) if ((l.provider === 'github' || l.provider === 'gitlab') && l.kind !== 'item') linked.add(`${l.kind === 'issue' ? 'issue' : 'pr'}:${l.ref.slice(1)}`);
    return { floor, dir, branches: new Set(rows.map((r) => r.branch).filter((b): b is string => !!b)), linked };
  }

  /** The Runs as last read: new dispatches are handoffs from the head to the worker (#34). */
  applyRuns(runs: OrcaRun[], now: number): void {
    this.now = now;
    const dispatches = runs.flatMap((r) => r.workers.map((w) => ({ run: r, w })));
    if (this.seenDispatch) {
      for (const { run, w } of dispatches) {
        if (this.seenDispatch.has(w.dispatchId)) continue;
        const task = run.tasks.find((t) => t.id === w.taskId);
        this.pendingHandoffs.push({ kind: 'dispatch', subject: task?.title ?? null, runId: run.id, dispatchId: w.dispatchId, toHead: false });
      }
    }
    this.seenDispatch = new Set(dispatches.map((d) => d.w.dispatchId));
    const gates = new Set(runs.flatMap((r) => r.gates.map((g) => g.id)));
    for (const id of gates) if (!this.gateSince.has(id)) this.gateSince.set(id, now);
    for (const id of this.gateSince.keys()) if (!gates.has(id)) this.gateSince.delete(id);
    const key = JSON.stringify(runs);
    if (key === this.runsKey) return;
    this.runsKey = key;
    this.runs = runs;
    this.version++;
  }

  /**
   * The mailbox (`orca orchestration inbox`): who coordinates which Run (the sender of mail to one
   * of its dispatches), and, for mail not seen before, a delivery to animate.
   */
  applyInbox(messages: InboxMessage[], now: number): void {
    this.now = now;
    const runOf = (dispatchId: string | null) => (dispatchId ? this.runs.find((r) => r.workers.some((w) => w.dispatchId === dispatchId))?.id : undefined) ?? null;
    let learned = false;
    for (const m of messages) {
      const toDispatch = m.to.startsWith('dispatch:') ? m.to.slice(9) : null;
      if (toDispatch && m.from.startsWith('orca_session_id:')) {
        const run = runOf(toDispatch);
        if (run && this.coordinators.get(run) !== m.from.slice(16)) {
          this.coordinators.set(run, m.from.slice(16));
          learned = true;
        }
      }
    }
    if (this.seenMail) {
      for (const m of messages) {
        if (this.seenMail.has(m.id) || !m.kind) continue;
        const toRun = m.to.startsWith('run:') ? m.to.slice(4) : null;
        const dispatchId = (m.to.startsWith('dispatch:') ? m.to.slice(9) : null) ?? m.dispatchId;
        this.pendingHandoffs.push({ kind: m.kind, subject: m.subject, runId: toRun ?? runOf(dispatchId), dispatchId, toHead: !!toRun });
      }
    }
    this.seenMail = new Set(messages.map((m) => m.id));
    if (learned || this.pendingHandoffs.length) this.version++;
  }

  /**
   * Deliveries to animate since last asked, placed on floors by the building just made: in the
   * project room from seat to seat, and at the worker's own desk on its repository's floor (up to the
   * roof, or down from it).
   */
  takeHandoffs(): Handoff[] {
    const out: Handoff[] = [];
    for (const h of this.pendingHandoffs.splice(0)) {
      const room = h.runId ? this.roomSeats.get(`run:${h.runId}`) : undefined;
      const seat = h.dispatchId ? (room?.byDispatch.get(h.dispatchId) ?? null) : null;
      if (room) out.push({ floor: room.floor, from: h.toHead ? seat : room.head, to: h.toHead ? room.head : seat, kind: h.kind, subject: h.subject });
      const run = this.runs.find((r) => r.id === h.runId);
      const w = run?.workers.find((x) => x.dispatchId === h.dispatchId);
      const desk = w?.workspace ? this.deskOfWorktree(w.workspace) : null;
      if (desk) out.push({ floor: desk.floor, from: h.toHead ? desk.seat : null, to: h.toHead ? null : desk.seat, kind: h.kind, subject: h.subject });
    }
    return out;
  }

  /** The floor and a seat of a worktree's desk (`<repoId>::<path>`), as last built. */
  private deskOfWorktree(worktreeId: string): { floor: string; seat: string } | null {
    const path = worktreePath(worktreeId) ?? worktreeId;
    const ws = this.byPath.get(`${LOCAL}|${path}`);
    if (!ws) return null;
    for (const [floor, seats] of this.deskSeats) {
      if (floor.startsWith('p-')) continue;
      for (const [seat, key] of seats) if (key === ws.id) return { floor, seat };
    }
    return null;
  }

  /** `orca terminal list --json`: each local pane's terminal handle. */
  applyTerminals(list: CliTerminal[]): void {
    this.paneTerminals = new Map(list.map((t) => [t.paneKey, t.handle]));
  }

  // ---- what the office's actions reach (M3) ---------------------------------------------------

  /** The Orca side of a figure: its terminal (local terminal agents), workspace and kind. */
  target(workerId: string): { paneKey: string; kind: 'chat' | 'terminal'; local: boolean; terminalId: string | null; workspaceId: string | null; sessionId: string | null; state: OrcaState; agent: string | null; since: number } | null {
    const pane = this.workerIds.get(workerId);
    const a = pane ? this.agents.get(pane) : undefined;
    if (!a) return null;
    const local = a.hostId === LOCAL;
    return { paneKey: a.paneKey, kind: a.kind, local, terminalId: local && a.kind === 'terminal' ? this.terminalOf(a.paneKey) : null, workspaceId: this.workspaces.has(a.deskKey) ? a.deskKey : null, sessionId: a.sessionId, state: a.shown, agent: a.agent, since: a.shownSince };
  }

  /** The bot a figure is (Staff floor or the head of a project room), by its figure id; null for anyone else. */
  botOf(workerId: string): OrcaBot | null {
    return this.bots.find((b) => botWorkerId(b) === workerId) ?? null;
  }

  /** A bot by its exact name, as `orca bot list` gives it. */
  botNamed(name: string): OrcaBot | null {
    return this.bots.find((b) => b.name === name) ?? null;
  }

  /** The Orca workspace at a seat on a floor (any seat of its desk cluster), when it is one Orca lists. */
  deskWorkspace(floorId: string, deskId: string): OrcaWorkspace | null {
    const key = this.deskSeats.get(floorId)?.get(deskId);
    return (key && this.workspaces.get(key)) || null;
  }

  /** Where a new task on this floor goes: its Orca project on this machine. */
  floorProject(floorId: string): { projectId: string } | null {
    for (const w of this.workspaces.values()) {
      if (w.kind !== 'worktree' || !w.projectId || (w.hostId ?? LOCAL) !== LOCAL) continue;
      if (floorId === this.floorIdOf(w)) return { projectId: w.projectId };
    }
    return null;
  }

  /** The seat and floor of the first figure at a workspace (a new task's id from `workspace.create`), once it sits down. */
  seatOfWorkspace(workspaceId: string): { floor: string; deskId: string } | null {
    const path = worktreePath(workspaceId);
    const ws = this.workspaces.get(workspaceId) ?? [...this.workspaces.values()].find((w) => w.kind === 'worktree' && !!path && w.path === path);
    if (!ws || ![...this.agents.values()].some((a) => a.deskKey === ws.id)) return null;
    for (const [floor, seats] of this.deskSeats) for (const [seat, key] of seats) if (key === ws.id) return { floor, deskId: seat };
    return null;
  }

  private terminalOf(paneKey: string): string | null {
    for (const [t, p] of this.terminals) if (p === paneKey) return t;
    return this.paneTerminals.get(paneKey) ?? null;
  }

  /** `orca bot list --json`: the Staff floor's people. */
  applyBots(bots: OrcaBot[]): void {
    this.bots = [...bots].sort((a, b) => a.name.localeCompare(b.name));
    this.version++;
  }

  /** Time passing: a done shown once its debounce is over, stale actions and provisional agents let go. */
  tick(now: number): void {
    let changed = false;
    for (const [k, a] of this.agents) {
      if (a.pendingDone !== null && now - a.pendingDone >= DONE_DEBOUNCE_MS) {
        this.show(a, 'done', a.pendingDone);
        changed = true;
      }
      if (a.action && now - a.actionAt > ACTION_MS) {
        a.action = null;
        changed = true;
      }
      for (const [id, since] of a.helpers) {
        if (now - since <= HELPER_MAX_MS) continue;
        a.helpers.delete(id);
        changed = true;
      }
      if (a.provisional && now - a.firstSeen > PROVISIONAL_MS) {
        this.agents.delete(k);
        changed = true;
      }
    }
    if (changed) this.version++;
  }

  // ---- output ---------------------------------------------------------------------------------

  building(): Building {
    this.workerIds.clear();
    this.deskSeats.clear();
    const floors = new Map<string, { desks: Map<string, DeskRec>; agents: Map<string, AgentRec[]> }>();
    const floorOf = (key: string) => {
      let f = floors.get(key);
      if (!f) floors.set(key, (f = { desks: new Map(), agents: new Map() }));
      return f;
    };
    for (const w of this.workspaces.values()) {
      if (w.kind === 'folder' && this.botFolders.has(w.id)) continue;
      if (w.state === 'inactive') continue;
      floorOf(floorKeyOf(w)).desks.set(w.id, deskOf(w));
    }
    for (const a of this.agents.values()) {
      const f = floorOf(a.floor);
      if (!f.desks.has(a.deskKey)) {
        const ws = this.workspaces.get(a.deskKey);
        f.desks.set(a.deskKey, ws ? deskOf(ws) : remoteDesk(a));
      }
      f.agents.set(a.deskKey, [...(f.agents.get(a.deskKey) ?? []), a]);
    }
    const out: LiveFloor[] = [];
    const names = this.floorNames([...floors.keys()]);
    const order = [...floors].sort(([a], [b]) => names.get(a)!.localeCompare(names.get(b)!) || a.localeCompare(b));
    for (const [key, f] of order) out.push(this.floor(key, names.get(key)!, f.desks, f.agents));
    // Project rooms on the roof (#29, #30): Runs first, worktree lineage where no Run covers it.
    const rooms = this.roomSpecs();
    this.botAway = new Map(rooms.flatMap((r) => (r.head && 'bot' in r.head ? [[r.head.bot.id, roomFloorId(r.key)] as [string, string]] : [])));
    if (this.bots.length) out.push(this.staffFloor());
    const projects: Building['projects'] = {};
    this.roomSeats.clear();
    for (const r of rooms) {
      const { floor, board } = this.roomFloor(r);
      out.push(floor);
      projects[floor.info.id] = board;
    }
    for (const id of this.seats.keys()) if (!out.some((f) => f.info.id === id)) this.seats.delete(id);
    return { floors: out, projects, waiting: this.waitingList(out, projects), roster: roster(out) };
  }

  /**
   * Everyone in the building waiting for you (A1) and the open decision gates (A2), longest first.
   * A project room's figures are mirrors of desks downstairs, so only its gates count there.
   */
  private waitingList(floors: LiveFloor[], projects: Building['projects']): OrcaWaiting[] {
    const out: OrcaWaiting[] = [];
    for (const f of floors) {
      if (f.info.room !== 'project') {
        for (const w of f.workers) {
          if (w.status !== 'needs_input') continue;
          out.push({
            key: w.id,
            kind: 'agent',
            floor: f.info.id,
            floorName: f.info.name,
            workerId: w.id,
            deskId: w.deskId,
            name: w.task?.name ?? w.name,
            ask: w.task?.summary ?? null,
            since: w.waitingSince ?? w.createdAt,
            ...(w.orca?.asks ? { asks: w.orca.asks } : {}),
            ...(w.orca?.terminal ? { terminal: true } : {}),
          });
        }
      }
      for (const g of projects[f.info.id]?.gates ?? []) {
        out.push({ key: `gate:${g.id}`, kind: 'gate', floor: f.info.id, floorName: f.info.name, workerId: null, deskId: g.seat, name: 'Decision', ask: g.question, since: this.gateSince.get(g.id) ?? this.now });
      }
    }
    return out.sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
  }

  /** The project rooms there are now: one per live Run, then lineages across repos no Run covers. */
  private roomSpecs(): RoomSpec[] {
    const specs: RoomSpec[] = [];
    const covered = new Set<string>();
    const byId = new Map(this.worktreeRows.map((w) => [w.id, w]));
    const nameOf = (worktreeId: string) => byId.get(worktreeId)?.name ?? this.byPath.get(`${LOCAL}|${worktreePath(worktreeId) ?? ''}`)?.name ?? (worktreePath(worktreeId) ?? worktreeId).split('/').pop() ?? 'worktree';
    for (const run of this.runs) {
      if (!isLive(run, this.now, RECENT_MS)) continue;
      // One seat per task that has (or had) a worker; the newest dispatch of each task.
      const seats: RoomSeat[] = [];
      const seen = new Set<string>();
      for (const w of [...run.workers].reverse()) {
        const k = w.taskId ?? w.dispatchId;
        if (seen.has(k)) continue;
        seen.add(k);
        const task = run.tasks.find((t) => t.id === w.taskId);
        if (w.workspace) covered.add(w.workspace);
        seats.push({ path: w.workspace, name: w.workspace ? nameOf(w.workspace) : 'worker', status: task?.status ?? null, dispatchId: w.dispatchId, taskId: w.taskId });
      }
      seats.reverse();
      specs.push({ key: `run:${run.id}`, source: 'run', runId: run.id, objective: run.objective, head: this.coordinatorOf(run), seats, tasks: run.tasks, gates: run.gates });
    }
    // Lineage: a parent worktree and its children, when they span repositories or there are 2+ children.
    const children = (w: OrcaWorktree): OrcaWorktree[] => w.childIds.map((c) => byId.get(c)).filter((c): c is OrcaWorktree => !!c);
    for (const root of this.worktreeRows) {
      if (root.parentId && byId.has(root.parentId)) continue;
      const desc: OrcaWorktree[] = [];
      const walk = (w: OrcaWorktree, depth: number) => {
        for (const c of children(w)) {
          if (desc.includes(c) || depth > 4) continue;
          desc.push(c);
          walk(c, depth + 1);
        }
      };
      walk(root, 0);
      if (!desc.length) continue;
      const members = [root, ...desc];
      const repos = new Set(members.map((m) => m.repoId ?? m.id.split('::')[0]));
      if (repos.size < 2 && desc.length < 2) continue;
      if (members.some((m) => covered.has(m.id))) continue;
      // Only while someone works there or Orca has one of them open.
      const busy = members.some((m) => {
        const ws = this.byPath.get(`${LOCAL}|${m.path}`);
        return (ws && ws.state !== 'inactive') || [...this.agents.values()].some((a) => ws && a.deskKey === ws.id);
      });
      if (!busy) continue;
      const rootAgent = this.agentsAtPath(root.path)[0];
      specs.push({
        key: `lin:${root.id}`,
        source: 'lineage',
        runId: null,
        objective: this.lineageName(root),
        head: rootAgent ? { agent: rootAgent } : { path: root.id, name: root.name },
        seats: desc.map((d) => ({ path: d.id, name: d.name, status: null, dispatchId: null, taskId: null })),
        tasks: [],
        gates: [],
      });
    }
    return specs;
  }

  /**
   * A lineage room's name: "<repo> · <root>" (the root is often the repository's own checkout, which
   * Orca calls "main"), the root's name alone when it already names the repository.
   */
  private lineageName(root: OrcaWorktree): string {
    const ws = this.byPath.get(`${LOCAL}|${root.path}`) ?? [...this.workspaces.values()].find((w) => w.kind === 'worktree' && !!root.projectId && w.projectId === root.projectId);
    const repo = ws?.project ?? (root.isMain ? (root.path.split(/[/\\]/).filter(Boolean).pop() ?? null) : null);
    const label = root.isMain && root.branch ? root.branch : root.name;
    return !repo || repo === label ? label : `${repo} · ${label}`;
  }

  /** Who coordinates a Run: its coordinator handle's terminal, else the sender of its dispatches' mail (a bot's chat or an agent). */
  private coordinatorOf(run: OrcaRun): RoomSpec['head'] {
    if (run.coordinatorHandle) {
      const pane = [...this.paneTerminals].find(([, h]) => h === run.coordinatorHandle)?.[0] ?? [...this.terminals].find(([t]) => t === run.coordinatorHandle)?.[1];
      const a = pane ? this.agents.get(pane) : undefined;
      if (a) return { agent: a };
    }
    const session = this.coordinators.get(run.id);
    if (!session) return null;
    for (const [name, chats] of this.botChats) {
      if (!chats.some((c) => c.sessionId === session)) continue;
      const bot = this.bots.find((b) => b.name.toLowerCase() === name);
      if (bot) return { bot };
    }
    const a = [...this.agents.values()].find((x) => x.sessionId === session);
    return a ? { agent: a } : null;
  }

  private agentsAtPath(worktreeIdOrPath: string): AgentRec[] {
    const path = worktreePath(worktreeIdOrPath) ?? worktreeIdOrPath;
    const ws = this.byPath.get(`${LOCAL}|${path}`);
    if (!ws) return [];
    return [...this.agents.values()].filter((a) => a.deskKey === ws.id).sort((a, b) => RANK[a.shown] - RANK[b.shown] || a.firstSeen - b.firstSeen);
  }

  /** A project room: the head of the table and a seat per worker, each mirroring its desk downstairs. */
  private roomFloor(r: RoomSpec): { floor: LiveFloor; board: ProjectBoard } {
    const id = roomFloorId(r.key);
    const [head, ...rest] = ROOM_SEATS;
    const workers: WorkerInfo[] = [];
    const labels: FloorPlan['labels'] = {};
    const deskSeats = new Map<string, string>();
    const byDispatch = new Map<string, string>();
    let coordinator: ProjectBoard['coordinator'] = null;
    const h = r.head;
    if (h && 'bot' in h) {
      workers.push(this.botWorker(h.bot, head!));
      coordinator = { name: h.bot.name, bot: true };
      labels[head!] = { text: cleanLabel(`👑 ${h.bot.name}`), color: '#9b5de5', by: 'orca', at: 0 };
      const folder = [...this.botFolders].find((f) => this.workspaces.get(f)?.name.toLowerCase() === h.bot.name.toLowerCase());
      if (folder) deskSeats.set(head!, folder);
    } else if (h && 'agent' in h) {
      workers.push(this.mirror(r.key, h.agent, head!));
      const ws = this.workspaces.get(h.agent.deskKey);
      coordinator = { name: ws?.name ?? 'coordinator', bot: false };
      labels[head!] = { text: cleanLabel(`👑 ${ws?.name ?? 'Coordinator'}`), color: signColor([h.agent]), by: 'orca', at: 0 };
      if (ws) deskSeats.set(head!, ws.id);
    } else if (h && 'path' in h) {
      coordinator = { name: h.name, bot: false };
      labels[head!] = { text: cleanLabel(`👑 ${h.name}`), color: '#2b2d42', by: 'orca', at: 0 };
      const ws = this.byPath.get(`${LOCAL}|${worktreePath(h.path) ?? h.path}`);
      if (ws) deskSeats.set(head!, ws.id);
    } else {
      // Orca doesn't say who coordinates (coordinator_handle is null): the head stays empty, with a sign.
      labels[head!] = { text: cleanLabel('👑 Coordinator unknown'), color: '#2b2d42', by: 'orca', at: 0 };
    }
    r.seats.slice(0, rest.length).forEach((s, i) => {
      const seat = rest[i]!;
      if (s.dispatchId) byDispatch.set(s.dispatchId, seat);
      const ws = s.path ? this.byPath.get(`${LOCAL}|${worktreePath(s.path) ?? s.path}`) : undefined;
      if (ws) deskSeats.set(seat, ws.id);
      const here = s.path ? this.agentsAtPath(s.path) : [];
      if (here[0]) workers.push(this.mirror(r.key, here[0], seat));
      labels[seat] = { text: cleanLabel(`${s.status ? TASK_ICON[s.status] : '🪑'} ${s.name}`), color: here[0] ? signColor(here) : s.status ? TASK_COLOR[s.status] : '#2b2d42', by: 'orca', at: 0 };
    });
    this.deskSeats.set(id, deskSeats);
    this.roomSeats.set(r.key, { floor: id, head: head!, byDispatch });
    const taskSeat = (taskId: string | null) => {
      const s = r.seats.findIndex((x) => x.taskId === taskId);
      return s >= 0 && s < rest.length && deskSeats.has(rest[s]!) ? rest[s]! : deskSeats.has(head!) ? head! : null;
    };
    const busy = workers.filter((w) => w.status === 'working').length;
    const waiting = workers.filter((w) => w.status === 'needs_input').length + r.gates.length;
    const name = r.objective ?? (r.source === 'run' ? 'Project' : 'Worktree family');
    return {
      floor: {
        info: { id, name, dir: '', palette: hash(r.key) % FLOOR_PALETTES.length, addedBy: 'orca', addedAt: 0, workers: 1 + r.seats.length, busy, waiting, people: 0, wing: 0, room: 'project' },
        workers,
        plan: { wing: 0, labels },
        links: {},
        services: [],
      },
      board: {
        source: r.source,
        objective: r.objective,
        coordinator,
        tasks: r.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
        gates: r.gates.map((g) => ({ id: g.id, question: g.question, options: g.options, seat: taskSeat(g.taskId) })),
        members: r.source === 'lineage' ? r.seats.map((s) => s.name) : [],
      },
    };
  }

  /** A figure from a desk downstairs, mirrored at a seat in a project room (same look, same state; actions reach the same agent). */
  private mirror(roomKey: string, a: AgentRec, seat: string): WorkerInfo {
    const ws = this.workspaces.get(a.deskKey);
    const w = this.worker(a, seat, ws ? deskOf(ws) : remoteDesk(a));
    const id = `m-${hash(`${roomKey}|${a.paneKey}`).toString(36)}`;
    this.workerIds.set(id, a.paneKey);
    return { ...w, id };
  }

  // ---- internals ------------------------------------------------------------------------------

  private floor(key: string, name: string, desks: Map<string, DeskRec>, agents: Map<string, AgentRec[]>): LiveFloor {
    const id = floorId(nameOfKey(key), key);
    const ordered = [...desks.values()].sort((a, b) => deskRank(agents.get(a.key)) - deskRank(agents.get(b.key)) || b.lastActivityAt - a.lastActivityAt || a.key.localeCompare(b.key));
    const want = new Map(ordered.map((d) => [d.key, Math.max(1, Math.min(MAX_SEATS, agents.get(d.key)?.length ?? 0))]));
    const seats = allocate(this.seats.get(id) ?? new Map(), ordered.map((d) => d.key), want);
    this.seats.set(id, seats);
    this.deskSeats.set(id, new Map([...seats].flatMap(([key, at]) => at.map((s) => [s, key] as [string, string]))));
    const workers: WorkerInfo[] = [];
    const labels: FloorPlan['labels'] = {};
    const links: LiveFloor['links'] = {};
    const services: ServiceInfo[] = [];
    const listed = new Set<string>();
    let wing = 0;
    for (const d of ordered) {
      const at = seats.get(d.key);
      if (!at) continue;
      const list = (agents.get(d.key) ?? []).sort((a, b) => a.firstSeen - b.firstSeen || a.paneKey.localeCompare(b.paneKey));
      list.slice(0, at.length).forEach((a, i) => workers.push(this.worker(a, at[i]!, d, i)));
      const extra = list.length - at.length;
      const sign = at.find((s) => !s.startsWith('beanbag-'));
      const path = d.hostId === LOCAL ? this.workspaces.get(d.key)?.path : undefined;
      const mine = path ? this.linksByPath.get(path) : undefined;
      // Every seat of the desk has its links, so the hint finds them wherever you stand.
      if (mine?.length) for (const s of at) links[s] = mine;
      const ports = path ? this.portsByPath.get(path) : undefined;
      if (path && ports) {
        listed.add(path);
        const first = workers.find((w) => at.includes(w.deskId ?? ''));
        for (const p of ports) services.push(serviceOf(p, first?.id ?? '', sign ?? at[0], this.workspaces.get(d.key)?.branch ?? null));
      }
      const pins = [mine?.length ? pinsText(mine) : '', ports?.length ? portsText(ports) : ''].filter(Boolean).join(' · ');
      if (sign) labels[sign] = { text: cleanLabel(`${d.hostId !== LOCAL ? '🌐 ' : ''}${d.name}${extra > 0 ? ` +${extra}` : ''}`), color: signColor(list), by: 'orca', at: 0, ...(pins ? { pins } : {}) };
      for (const s of at) if (WING_IDS.has(s)) wing = 2;
    }
    // Servers in this repository's worktrees that have no desk here (Orca has them closed).
    for (const [path, ports] of this.portsByPath) {
      const ws = this.byPath.get(`${LOCAL}|${path}`);
      if (listed.has(path) || !ws || floorKeyOf(ws) !== key) continue;
      for (const p of ports) services.push(serviceOf(p, '', undefined, ws.branch));
    }
    services.sort((a, b) => a.port - b.port);
    const busy = workers.filter((w) => w.status === 'working').length;
    const waiting = workers.filter((w) => w.status === 'needs_input').length;
    // The repository's own checkout; without one Orca lists, the first local desk's worktree.
    const first = ordered.find((d) => d.hostId === LOCAL)?.key;
    const dir = this.mainCheckout(key) ?? (first ? (this.workspaces.get(first)?.path ?? '') : '');
    return {
      info: { id, name, dir, palette: hash(name) % FLOOR_PALETTES.length, addedBy: 'orca', addedAt: 0, workers: workers.length, busy, waiting, people: 0, wing, ...(this.floorProject(id) ? { orcaCreate: true } : {}) },
      workers,
      plan: { wing, labels },
      links,
      services,
    };
  }

  /** A figure: named after its worktree (A5), the second at a desk "fix-login · 2". */
  private worker(a: AgentRec, deskId: string, d: DeskRec, nth = 0): WorkerInfo {
    const h = hash(a.paneKey);
    const branch = d.hostId === LOCAL ? this.workspaces.get(d.key)?.branch : null;
    this.workerIds.set(`a-${h.toString(36)}`, a.paneKey);
    const status = STATUS[a.shown];
    const tag = [a.kind === 'chat' ? '💬' : '', a.hostId !== LOCAL ? `🌐 ${hostLabel(a.hostId)}` : ''].filter(Boolean).join(' ');
    const working = a.shown === 'working';
    return {
      id: `a-${h.toString(36)}`,
      kind: 'agent',
      ...(isAgentProvider(a.agent) ? { provider: a.agent } : {}),
      deskId,
      name: cleanLabel(`${d.name}${nth > 0 ? ` · ${nth + 1}` : ''}`).slice(0, 40) || NAMES[h % NAMES.length]!,
      color: WORKER_COLORS[(h >>> 5) % WORKER_COLORS.length]!,
      status,
      acked: !d.unread,
      ...(status !== 'working' ? { waitingSince: a.shownSince } : {}),
      createdBy: 'orca',
      createdAt: a.firstSeen,
      cols: 100,
      rows: 30,
      viewers: [],
      viewerIds: [],
      task: { name: `${tag ? `${tag} ` : ''}${d.name}`, summary: a.bubble ?? SUMMARY[a.shown] },
      orca: {
        terminal: a.kind === 'terminal' && a.hostId === LOCAL,
        remote: a.hostId !== LOCAL,
        worktree: d.name,
        ...(branch ? { branch: branch.replace(/^refs\/heads\//, '') } : {}),
        ...(status === 'needs_input' ? { asks: a.shown === 'blocked' ? 'permission' : 'question' } : {}),
        ...(working ? { quietSince: a.quietSince } : {}),
      },
      ...(working && a.action ? { action: a.action } : {}),
      ...(working && a.activity ? { activity: a.activity } : {}),
      ...(working && a.workingSince ? { workingSince: a.workingSince } : {}),
      ...(a.helpers.size ? { helpers: a.helpers.size } : {}),
    };
  }

  private staffFloor(): LiveFloor {
    const id = STAFF_FLOOR;
    // A desk cluster of its own for each bot (its office) while there are clusters, in name order.
    const seats = new Map(this.bots.map((b, i) => [`bot:${b.id}`, [STAFF_SEATS[i]!]]));
    const workers: WorkerInfo[] = [];
    const labels: FloorPlan['labels'] = {};
    let wing = 0;
    for (const b of this.bots) {
      const deskId = seats.get(`bot:${b.id}`)?.[0];
      if (!deskId) continue;
      // Coordinating a Run (#33): it went up to the project room; its office waits with a note.
      if (this.botAway.has(b.id)) {
        if (!deskId.startsWith('beanbag-')) labels[deskId] = { text: cleanLabel(`🤖 ${b.name} → 🏗️ roof`), color: '#9b5de5', by: 'orca', at: 0 };
        if (WING_IDS.has(deskId)) wing = 2;
        continue;
      }
      workers.push(this.botWorker(b, deskId));
      if (!deskId.startsWith('beanbag-')) labels[deskId] = { text: cleanLabel(`🤖 ${b.name}`), color: '#9b5de5', by: 'orca', at: 0 };
      if (WING_IDS.has(deskId)) wing = 2;
    }
    const busy = workers.filter((w) => w.status === 'working').length;
    const waiting = workers.filter((w) => w.status === 'needs_input').length;
    return {
      info: { id, name: 'Staff', dir: '', palette: hash('Staff') % FLOOR_PALETTES.length, addedBy: 'orca', addedAt: 0, workers: workers.length, busy, waiting, people: 0, wing, room: 'staff' },
      workers,
      plan: { wing, labels },
      links: {},
      services: [],
    };
  }

  /** A bot as a figure (on the Staff floor, or at the head of a project room): stable id and look, state from its chats. */
  private botWorker(b: OrcaBot, deskId: string): WorkerInfo {
    {
      const chats = this.botChats.get(b.name.toLowerCase()) ?? [];
      const st = chats.reduce<OrcaState | null>((best, c) => (best === null || RANK[c.state] < RANK[best] ? c.state : best), null);
      const status: WorkerStatus = b.paused ? 'offline' : st === 'working' ? 'working' : st === 'blocked' || st === 'waiting' ? 'needs_input' : 'idle';
      const said = chats.find((c) => c.state === st)?.bubble ?? null;
      const h = hash(b.id);
      return {
        id: botWorkerId(b),
        kind: 'agent',
        ...(isAgentProvider(b.agent) ? { provider: b.agent } : {}),
        deskId,
        name: b.name,
        color: WORKER_COLORS[h % WORKER_COLORS.length]!,
        status,
        acked: true,
        createdBy: 'orca',
        createdAt: 0,
        cols: 100,
        rows: 30,
        viewers: [],
        viewerIds: [],
        task: { name: `🤖 ${b.name}`, summary: b.paused ? '⏸ paused' : status === 'working' && said ? said : (b.specialty ?? 'Bot') },
        orca: { terminal: false, remote: false, bot: b.name },
      };
    }
  }

  /** The bots' chat agents, by bot name (lowercase): from the local CLI list. */
  private botChats = new Map<string, CliAgent[]>();

  private bumpBotChats(list: CliAgent[]) {
    const names = new Set(this.bots.map((b) => b.name.toLowerCase()));
    const by = new Map<string, CliAgent[]>();
    for (const c of list) {
      if (!this.isBotChat(c)) continue;
      const k = c.workspace.toLowerCase();
      if (!names.has(k) && !this.botFolders.has(c.worktreeId)) continue;
      by.set(k, [...(by.get(k) ?? []), c]);
    }
    this.botChats = by;
  }

  private isBotChat(c: CliAgent): boolean {
    if (c.hostId !== LOCAL || !c.worktreeId.startsWith('folder:')) return false;
    return this.botFolders.has(c.worktreeId) || this.bots.some((b) => b.name.toLowerCase() === c.workspace.toLowerCase());
  }

  /** The desk (worktree) a CLI agent sits at, and its floor. */
  private deskFor(c: CliAgent): { key: string; floor: string } {
    if (c.hostId === LOCAL) {
      const ws = this.workspaces.get(c.worktreeId) ?? this.byPath.get(`${LOCAL}|${worktreePath(c.worktreeId) ?? ''}`);
      if (ws) return { key: ws.id, floor: floorKeyOf(ws) };
    }
    return { key: `${c.hostId}|${c.worktreeId}|${c.workspace}`, floor: this.floorKeyNamed(c.repo ?? (c.worktreeId.startsWith('folder:') ? 'Folders' : 'Other')) };
  }

  /** A repo a remote agent names: the floor of the one Orca project called that, else a floor by the name. */
  private floorKeyNamed(name: string): string {
    const keys = new Set([...this.workspaces.values()].filter((w) => w.kind === 'worktree' && w.projectId && w.project === name).map(floorKeyOf));
    return keys.size === 1 ? [...keys][0]! : `n:${name}`;
  }

  /** A workspace's floor id. */
  private floorIdOf(w: OrcaWorkspace): string {
    return floorId(floorNameOf(w), floorKeyOf(w));
  }

  /**
   * The directory of a project's floor: the repository's own checkout (`isMainWorktree` in `orca
   * worktree list`), by project id, or by the repository of the floor's worktrees on an Orca whose
   * rows have no project id. Null for a floor by name, or when Orca doesn't list the checkout.
   */
  private mainCheckout(key: string): string | null {
    if (!key.startsWith('p:')) return null;
    const projectId = key.slice(2);
    const main = this.worktreeRows.filter((r) => r.isMain);
    const byProject = main.find((r) => r.projectId === projectId);
    if (byProject) return byProject.path;
    const paths = new Set([...this.workspaces.values()].filter((w) => w.kind === 'worktree' && (w.hostId ?? LOCAL) === LOCAL && floorKeyOf(w) === key).map((w) => w.path));
    const repoId = this.worktreeRows.find((r) => paths.has(r.path) && r.repoId)?.repoId;
    return (repoId && main.find((r) => !r.projectId && r.repoId === repoId)?.path) || null;
  }

  /** The name each floor shows: its repository's; two repositories called the same get their project's id after it. */
  private floorNames(keys: string[]): Map<string, string> {
    const base = new Map(keys.map((k) => [k, nameOfKey(k)]));
    for (const w of this.workspaces.values()) {
      const k = floorKeyOf(w);
      if (base.has(k)) base.set(k, floorNameOf(w));
    }
    const count = new Map<string, number>();
    for (const n of base.values()) count.set(n, (count.get(n) ?? 0) + 1);
    return new Map([...base].map(([k, n]) => [k, (count.get(n) ?? 0) > 1 && k.startsWith('p:') ? `${n} · ${projectTag(k.slice(2))}` : n]));
  }

  private agentForHook(h: ToolHook): AgentRec | undefined {
    const pane = h.terminalId ? this.terminals.get(h.terminalId) : undefined;
    if (pane) return this.agents.get(pane);
    // Not learned yet: the only working terminal agent at that worktree.
    const path = h.workspaceId ? worktreePath(h.workspaceId) : null;
    const ws = path ? this.byPath.get(`${LOCAL}|${path}`) : undefined;
    if (!ws) return undefined;
    const here = [...this.agents.values()].filter((a) => a.deskKey === ws.id && a.kind === 'terminal' && a.shown === 'working');
    return here.length === 1 ? here[0] : undefined;
  }

  /**
   * Orca said something about it (B5): it isn't quiet any more. A page only needs to hear it when it
   * had been quiet for a while (it may be showing "stuck?"), so a stream of hooks costs nothing extra.
   */
  private heard(rec: AgentRec, at: number) {
    if (at <= rec.quietSince) return;
    if (at - rec.quietSince > QUIET_NEWS_MS) this.version++;
    rec.quietSince = at;
  }

  /** A state from Orca: de-duplicated, done held back for the debounce. Returns whether it changed what shows. */
  private setState(rec: AgentRec, st: OrcaState, now: number): boolean {
    if (st === 'done') {
      if (rec.shown !== 'done' && rec.pendingDone === null) rec.pendingDone = now;
      return false;
    }
    // Working again (or asking) before the debounce is over: the done never shows.
    rec.pendingDone = null;
    if (rec.shown === st) return false;
    this.show(rec, st, now);
    return true;
  }

  private show(rec: AgentRec, st: OrcaState, at: number) {
    rec.pendingDone = null;
    if (st === 'working' && rec.shown !== 'working') rec.workingSince = at;
    if (st !== 'working') {
      // Its turn is over: whatever subagents it had are done too.
      rec.helpers.clear();
      rec.action = null;
      rec.workingSince = null;
      rec.fails = 0;
    }
    rec.shown = st;
    rec.shownSince = at;
  }
}

/** Seats of a project room: the head of the table first (the room's first desk), then one per worker. */
const ROOM_SEATS = [...CLUSTERS.flat()];
const TASK_ICON: Record<TaskStatus, string> = { pending: '⏳', ready: '🟢', dispatched: '🛠️', in_progress: '🛠️', blocked: '⛔', completed: '✅', failed: '❌' };
const TASK_COLOR: Record<TaskStatus, string> = { pending: '#2b2d42', ready: '#118ab2', dispatched: '#ffd166', in_progress: '#ffd166', blocked: '#ef476f', completed: '#06d6a0', failed: '#ef476f' };

/** A project room's floor id: `p-…`, never a repository floor's (`f-…`). */
export function roomFloorId(key: string): string {
  return `p-${hash(key).toString(36)}`;
}

const SUMMARY: Record<OrcaState, string> = { working: 'Working…', blocked: 'Waiting for you', waiting: 'Waiting for you', done: 'Done' };

function newAgent(paneKey: string, deskKey: string, floor: string, now: number): AgentRec {
  return {
    paneKey,
    deskKey,
    floor,
    kind: 'terminal',
    agent: null,
    hostId: LOCAL,
    shown: 'done',
    shownSince: now,
    pendingDone: null,
    bubble: null,
    sessionId: null,
    firstSeen: now,
    provisional: false,
    lastSeen: now,
    action: null,
    actionAt: 0,
    activity: null,
    fails: 0,
    workingSince: null,
    helpers: new Map(),
    quietSince: now,
    updatedAt: 0,
  };
}

export function floorNameOf(w: OrcaWorkspace): string {
  return w.project ?? (w.kind === 'folder' ? 'Folders' : 'Other');
}

/**
 * A floor's key: `p:<projectId>` for a worktree of an Orca project, so two repositories called the same
 * are two floors and renaming one keeps its floor; `n:<name>` for folders and anything without a project.
 */
export function floorKeyOf(w: OrcaWorkspace): string {
  return w.kind === 'worktree' && w.projectId ? `p:${w.projectId}` : `n:${floorNameOf(w)}`;
}

/** The name in a floor key (a project's key has the id, the name comes from its workspaces). */
function nameOfKey(key: string): string {
  return key.slice(2);
}

/** A short tag for a project id, to tell apart two repositories called the same: "owner/name", or the start of an id. */
export function projectTag(projectId: string): string {
  const rest = projectId.replace(/^[a-z]+:/, '');
  const parts = rest.split('/').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return /^[0-9a-f-]{20,}$/i.test(rest) ? rest.slice(0, 8) : rest;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'floor';

/**
 * A floor's id. A repository's comes from its project id only, so it stays when the repository is
 * renamed; a floor without a project (folders, a remote repo Orca has no project for) by its name.
 */
export function floorId(name: string, key = `n:${name}`): string {
  if (key.startsWith('p:')) return `f-${slug(projectTag(key.slice(2)))}-${hash(key).toString(36)}`;
  return `f-${slug(name)}-${(hash(name) % 1296).toString(36)}`;
}

/** A dev server as the services board lists it (B7). */
function serviceOf(p: PortRow, workerId: string, deskId: string | undefined, branch: string | null): ServiceInfo {
  return {
    port: p.port,
    host: p.host,
    pid: p.pid,
    command: p.command,
    workerId,
    ...(deskId ? { deskId } : {}),
    worktree: p.worktree,
    ...(branch ? { branch } : {}),
    url: p.url ?? `http://localhost:${p.port}`,
    ...(p.title ? { title: p.title } : {}),
    since: p.since,
  };
}

/** The ports on a desk's sign: "🖥 :5173", the first two. */
export function portsText(ports: PortRow[]): string {
  const shown = ports.slice(0, 2).map((p) => `:${p.port}`);
  return `🖥 ${shown.join(' ')}${ports.length > 2 ? ` +${ports.length - 2}` : ''}`;
}

/** Every floor's figures, for ⌘K and the Workers panel (A6): repository floors and Staff; rooms only mirror them. */
function roster(floors: LiveFloor[]): OrcaRosterFloor[] {
  return floors
    .filter((f) => f.info.room !== 'project')
    .map((f) => ({
      floor: f.info.id,
      name: f.info.name,
      workers: f.workers.map((w) => ({
        id: w.id,
        name: w.name,
        status: w.status,
        deskId: w.deskId,
        ...(w.orca?.branch ? { branch: w.orca.branch } : {}),
        ...(w.task?.summary ? { summary: w.task.summary } : {}),
        ...(w.orca?.bot ? { bot: true } : {}),
        ...(w.orca?.terminal ? { terminal: true } : {}),
        ...(w.waitingSince ?? w.workingSince ? { since: w.waitingSince ?? w.workingSince } : {}),
        ...(w.orca?.asks ? { asks: w.orca.asks } : {}),
        ...(w.orca?.quietSince !== undefined ? { quietSince: w.orca.quietSince } : {}),
        ...(w.workingSince ? { workingSince: w.workingSince } : {}),
      })),
    }));
}

function deskOf(w: OrcaWorkspace): DeskRec {
  return { key: w.id, floor: floorKeyOf(w), name: w.name, hostId: w.hostId ?? LOCAL, open: true, unread: w.unread, lastActivityAt: w.lastActivityAt ?? 0 };
}

function remoteDesk(a: AgentRec): DeskRec {
  const name = a.deskKey.split('|')[2] || 'remote';
  return { key: a.deskKey, floor: a.floor, name, hostId: a.hostId, open: false, unread: false, lastActivityAt: a.shownSince };
}

function hostLabel(hostId: string): string {
  return hostId.replace(/^runtime:/, '').slice(0, 24);
}

function deskRank(list: AgentRec[] | undefined): number {
  if (!list?.length) return 3;
  return Math.min(...list.map((a) => RANK[a.shown]));
}

function signColor(list: AgentRec[]): string {
  const r = deskRank(list);
  return r === 0 ? '#ef476f' : r === 1 ? '#ffd166' : '#2b2d42';
}

/**
 * Seats for each desk, in priority order: a desk keeps the seats it had if it still fits them (and
 * gives back the ones it no longer needs); a new or growing desk gets `want` seats in one cluster
 * (the fullest one that fits), else free seats anywhere, a lone agent a bean bag last. Desks that
 * find no seat aren't shown.
 */
export function allocate(prev: Map<string, string[]>, order: string[], want: Map<string, number>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const taken = new Set<string>();
  const keep = new Set(order);
  // First the seats desks already had, so they don't move.
  for (const k of order) {
    const had = prev.get(k);
    const n = want.get(k) ?? 1;
    if (!had || !keep.has(k) || had.length < n) continue;
    const mine = had.slice(0, n);
    out.set(k, mine);
    for (const s of mine) taken.add(s);
  }
  const free = (ids: string[]) => ids.filter((s) => !taken.has(s));
  for (const k of order) {
    if (out.has(k)) continue;
    const n = want.get(k) ?? 1;
    const had = (prev.get(k) ?? []).filter((s) => !taken.has(s));
    let got: string[] | undefined;
    // Growing: stay in its cluster if it has room.
    if (had.length) {
      const c = CLUSTERS.find((cl) => cl.includes(had[0]!));
      if (c && free(c).length >= n) got = [...had.filter((s) => c.includes(s)), ...free(c).filter((s) => !had.includes(s))].slice(0, n);
    }
    if (!got) {
      const fits = CLUSTERS.filter((cl) => free(cl).length >= n).sort((a, b) => free(a).length - free(b).length);
      if (fits.length) got = free(fits[0]!).slice(0, n);
    }
    if (!got) {
      const anywhere = free([...CLUSTERS.flat(), ...BEANBAG_IDS]);
      if (anywhere.length) got = anywhere.slice(0, Math.min(n, anywhere.length));
    }
    if (!got?.length) continue;
    out.set(k, got);
    for (const s of got) taken.add(s);
  }
  return out;
}
