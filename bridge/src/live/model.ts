/**
 * The live office (M2, #16): Orca's workspaces and agents mapped onto the building.
 *
 *   floor  = repository (the worktree's Orca project, or the repo a remote agent names)
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
import type { FloorInfo, WorkerAction, WorkerInfo, WorkerStatus } from '@orca-office/shared/office/protocol';
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

const WORKER_COLORS = ['#ef476f', '#118ab2', '#ffd166', '#06d6a0', '#8338ec', '#f78c6b', '#4f86f7', '#073b4c', '#e76f51', '#2a9d8f', '#9b5de5', '#f15bb5'];
const NAMES = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Fa', 'Gu', 'Ha', 'Ivo', 'Jo', 'Kai', 'Lu', 'Mo', 'Nia', 'Oto', 'Pia', 'Rae', 'Sol', 'Tea', 'Uma', 'Vik', 'Wes', 'Xan', 'Yul', 'Zoe'];

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
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
  floorName: string;
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
}

interface DeskRec {
  key: string;
  floorName: string;
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
}

export interface Building {
  floors: LiveFloor[];
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
      if (ws) a.floorName = floorNameOf(ws);
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
      const rec: AgentRec = prev ?? newAgent(c.paneKey, desk.key, desk.floorName, now);
      Object.assign(rec, { deskKey: desk.key, floorName: desk.floorName, kind: c.kind, agent: c.agent, hostId: c.hostId, bubble: c.bubble, sessionId: c.sessionId, provisional: false, lastSeen: now });
      if (!prev) {
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
      rec = newAgent(ev.paneKey, ws.id, floorNameOf(ws), ev.at);
      Object.assign(rec, { kind: ev.terminalId ? 'terminal' : 'chat', hostId: ws.hostId ?? LOCAL, provisional: true, shown: ev.state, shownSince: ev.at, workingSince: ev.state === 'working' ? ev.at : null });
      this.agents.set(ev.paneKey, rec);
      this.version++;
      return true;
    }
    if (this.setState(rec, ev.state, ev.at)) this.version++;
    return false;
  }

  /** An `agent.tool.before` hook for a subagent tool: a small helper sits by its parent until the call ends. */
  applySubagentStart(h: ToolHook): void {
    const rec = this.agentForHook(h);
    if (!rec || !h.callId || rec.helpers.has(h.callId)) return;
    rec.helpers.set(h.callId, h.at);
    this.version++;
  }

  /** An `agent.tool.after` hook: what the agent at that terminal acts out. */
  applyHook(h: ToolHook): void {
    const rec = this.agentForHook(h);
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

  /** `orca terminal list --json`: each local pane's terminal handle. */
  applyTerminals(list: CliTerminal[]): void {
    this.paneTerminals = new Map(list.map((t) => [t.paneKey, t.handle]));
  }

  // ---- what the office's actions reach (M3) ---------------------------------------------------

  /** The Orca side of a figure: its terminal (local terminal agents), workspace and kind. */
  target(workerId: string): { paneKey: string; kind: 'chat' | 'terminal'; local: boolean; terminalId: string | null; workspaceId: string | null; sessionId: string | null } | null {
    const pane = this.workerIds.get(workerId);
    const a = pane ? this.agents.get(pane) : undefined;
    if (!a) return null;
    const local = a.hostId === LOCAL;
    return { paneKey: a.paneKey, kind: a.kind, local, terminalId: local && a.kind === 'terminal' ? this.terminalOf(a.paneKey) : null, workspaceId: this.workspaces.has(a.deskKey) ? a.deskKey : null, sessionId: a.sessionId };
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
      if (floorId === floorId_(floorNameOf(w))) return { projectId: w.projectId };
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
    const floorOf = (name: string) => {
      let f = floors.get(name);
      if (!f) floors.set(name, (f = { desks: new Map(), agents: new Map() }));
      return f;
    };
    for (const w of this.workspaces.values()) {
      if (w.kind === 'folder' && this.botFolders.has(w.id)) continue;
      if (w.state === 'inactive') continue;
      floorOf(floorNameOf(w)).desks.set(w.id, deskOf(w));
    }
    for (const a of this.agents.values()) {
      const f = floorOf(a.floorName);
      if (!f.desks.has(a.deskKey)) {
        const ws = this.workspaces.get(a.deskKey);
        f.desks.set(a.deskKey, ws ? deskOf(ws) : remoteDesk(a));
      }
      f.agents.set(a.deskKey, [...(f.agents.get(a.deskKey) ?? []), a]);
    }
    const out: LiveFloor[] = [];
    for (const [name, f] of [...floors].sort(([a], [b]) => a.localeCompare(b))) out.push(this.floor(name, f.desks, f.agents));
    if (this.bots.length) out.push(this.staffFloor());
    for (const id of this.seats.keys()) if (!out.some((f) => f.info.id === id)) this.seats.delete(id);
    return { floors: out };
  }

  // ---- internals ------------------------------------------------------------------------------

  private floor(name: string, desks: Map<string, DeskRec>, agents: Map<string, AgentRec[]>): LiveFloor {
    const id = floorId(name);
    const ordered = [...desks.values()].sort((a, b) => deskRank(agents.get(a.key)) - deskRank(agents.get(b.key)) || b.lastActivityAt - a.lastActivityAt || a.key.localeCompare(b.key));
    const want = new Map(ordered.map((d) => [d.key, Math.max(1, Math.min(MAX_SEATS, agents.get(d.key)?.length ?? 0))]));
    const seats = allocate(this.seats.get(id) ?? new Map(), ordered.map((d) => d.key), want);
    this.seats.set(id, seats);
    this.deskSeats.set(id, new Map([...seats].flatMap(([key, at]) => at.map((s) => [s, key] as [string, string]))));
    const workers: WorkerInfo[] = [];
    const labels: FloorPlan['labels'] = {};
    let wing = 0;
    for (const d of ordered) {
      const at = seats.get(d.key);
      if (!at) continue;
      const list = (agents.get(d.key) ?? []).sort((a, b) => a.firstSeen - b.firstSeen || a.paneKey.localeCompare(b.paneKey));
      list.slice(0, at.length).forEach((a, i) => workers.push(this.worker(a, at[i]!, d)));
      const extra = list.length - at.length;
      const sign = at.find((s) => !s.startsWith('beanbag-'));
      if (sign) labels[sign] = { text: cleanLabel(`${d.hostId !== LOCAL ? '🌐 ' : ''}${d.name}${extra > 0 ? ` +${extra}` : ''}`), color: signColor(list), by: 'orca', at: 0 };
      for (const s of at) if (WING_IDS.has(s)) wing = 2;
    }
    const busy = workers.filter((w) => w.status === 'working').length;
    const waiting = workers.filter((w) => w.status === 'needs_input').length;
    const dir = ordered.find((d) => d.hostId === LOCAL)?.key;
    return {
      info: { id, name, dir: dir ? (this.workspaces.get(dir)?.path ?? '') : '', palette: hash(name) % FLOOR_PALETTES.length, addedBy: 'orca', addedAt: 0, workers: workers.length, busy, waiting, people: 0, wing, ...(this.floorProject(id) ? { orcaCreate: true } : {}) },
      workers,
      plan: { wing, labels },
    };
  }

  private worker(a: AgentRec, deskId: string, d: DeskRec): WorkerInfo {
    const h = hash(a.paneKey);
    this.workerIds.set(`a-${h.toString(36)}`, a.paneKey);
    const status = STATUS[a.shown];
    const tag = [a.kind === 'chat' ? '💬' : '', a.hostId !== LOCAL ? `🌐 ${hostLabel(a.hostId)}` : ''].filter(Boolean).join(' ');
    const working = a.shown === 'working';
    return {
      id: `a-${h.toString(36)}`,
      kind: 'agent',
      ...(isAgentProvider(a.agent) ? { provider: a.agent } : {}),
      deskId,
      name: NAMES[h % NAMES.length]!,
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
      orca: { terminal: a.kind === 'terminal' && a.hostId === LOCAL, remote: a.hostId !== LOCAL },
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
      const chats = this.botChats.get(b.name.toLowerCase()) ?? [];
      const st = chats.reduce<OrcaState | null>((best, c) => (best === null || RANK[c.state] < RANK[best] ? c.state : best), null);
      const status: WorkerStatus = b.paused ? 'offline' : st === 'working' ? 'working' : st === 'blocked' || st === 'waiting' ? 'needs_input' : 'idle';
      const said = chats.find((c) => c.state === st)?.bubble ?? null;
      const h = hash(b.id);
      workers.push({
        id: `bot-${h.toString(36)}`,
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
      });
      if (!deskId.startsWith('beanbag-')) labels[deskId] = { text: cleanLabel(`🤖 ${b.name}`), color: '#9b5de5', by: 'orca', at: 0 };
      if (WING_IDS.has(deskId)) wing = 2;
    }
    const busy = workers.filter((w) => w.status === 'working').length;
    const waiting = workers.filter((w) => w.status === 'needs_input').length;
    return {
      info: { id, name: 'Staff', dir: '', palette: hash('Staff') % FLOOR_PALETTES.length, addedBy: 'orca', addedAt: 0, workers: workers.length, busy, waiting, people: 0, wing, room: 'staff' },
      workers,
      plan: { wing, labels },
    };
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
  private deskFor(c: CliAgent): { key: string; floorName: string } {
    if (c.hostId === LOCAL) {
      const ws = this.workspaces.get(c.worktreeId) ?? this.byPath.get(`${LOCAL}|${worktreePath(c.worktreeId) ?? ''}`);
      if (ws) return { key: ws.id, floorName: floorNameOf(ws) };
    }
    return { key: `${c.hostId}|${c.worktreeId}|${c.workspace}`, floorName: c.repo ?? (c.worktreeId.startsWith('folder:') ? 'Folders' : 'Other') };
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

const SUMMARY: Record<OrcaState, string> = { working: 'Working…', blocked: 'Waiting for you', waiting: 'Waiting for you', done: 'Done' };

function newAgent(paneKey: string, deskKey: string, floorName: string, now: number): AgentRec {
  return {
    paneKey,
    deskKey,
    floorName,
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
  };
}

export function floorNameOf(w: OrcaWorkspace): string {
  return w.project ?? (w.kind === 'folder' ? 'Folders' : 'Other');
}

/** floorId under another name, for the methods above whose locals are called floorId. */
const floorId_ = (name: string) => floorId(name);

export function floorId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'floor';
  return `f-${slug}-${(hash(name) % 1296).toString(36)}`;
}

function deskOf(w: OrcaWorkspace): DeskRec {
  return { key: w.id, floorName: floorNameOf(w), name: w.name, hostId: w.hostId ?? LOCAL, open: true, unread: w.unread, lastActivityAt: w.lastActivityAt ?? 0 };
}

function remoteDesk(a: AgentRec): DeskRec {
  const name = a.deskKey.split('|')[2] || 'remote';
  return { key: a.deskKey, floorName: a.floorName, name, hostId: a.hostId, open: false, unread: false, lastActivityAt: a.shownSince };
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
