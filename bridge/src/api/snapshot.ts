/**
 * The Office API's snapshot (docs/api.md, shared/src/office/api.ts): the model's records (apiState)
 * with the private texts put back in full. Pure: the time, the stuck rule and the inputs come in.
 */
import { createHash } from 'node:crypto';
import type {
  ApiAgent,
  ApiBot,
  ApiBotState,
  ApiFloor,
  ApiLink,
  ApiRoom,
  ApiRun,
  ApiServer,
  ApiSnapshot,
  ApiUsage,
  ApiWorktree,
} from '@orca-office/shared/office/api';
import { API_VERSION } from '@orca-office/shared/office/api';
import type { PlanLimits } from '@orca-office/shared/office/protocol';
import { STUCK_DEFAULTS, stuckWhy, type StuckRule } from '@orca-office/shared/office/stuck';
import { toBubble } from '@orca-office/shared';
import type { ApiModelState } from '../live/model.js';
import type { OrcaState } from '../live/orca.js';
import type { PortRow } from '../live/ports.js';
import type { PrivateTexts } from './private-texts.js';

/** A link's title on the API: longer than the office's sign, still one line. */
const LINK_TITLE = 80;
const RANK: Record<OrcaState, number> = { blocked: 0, waiting: 0, working: 1, done: 2 };

export interface SnapshotInput {
  state: ApiModelState;
  texts: PrivateTexts;
  connected: boolean;
  lastSnapshotAt: number | null;
  limits: PlanLimits | null;
  now: number;
  rule?: StuckRule;
}

/** The snapshot's content: everything but `version`, `at`, `rev` and `fingerprint`. */
export type SnapshotBody = Omit<ApiSnapshot, 'version' | 'at' | 'rev' | 'fingerprint'>;

export function snapshotBody(input: SnapshotInput): SnapshotBody {
  const { state: s, texts, now } = input;
  const rule = input.rule ?? STUCK_DEFAULTS;

  const agents: ApiAgent[] = s.agents.map((a) => {
    const needsYou = a.state === 'blocked' || a.state === 'waiting';
    const why = stuckWhy({ status: a.state, quietSince: a.quietSince, ...(a.workingSince ? { workingSince: a.workingSince } : {}) }, now, rule);
    const t = texts.agent(a.hostId, a.paneKey);
    return {
      id: a.id,
      worktreeId: a.deskKey,
      floorId: a.floorId,
      agent: a.agent,
      surface: a.kind,
      state: a.state,
      needsYou,
      asks: a.state === 'blocked' ? 'permission' : a.state === 'waiting' ? 'question' : null,
      stuck: why !== null,
      stuckWhy: why,
      since: a.since,
      quietSince: a.quietSince,
      title: t.title,
      question: needsYou ? (t.lastMessage ?? a.bubble) : null,
      bubble: a.bubble,
      lastAction: a.action,
      helpers: a.helpers,
      failed: a.state === 'done' && a.failed,
      orcaSessionId: a.orcaSessionId,
      sessionId: a.sessionId,
      paneKey: a.paneKey,
      terminalId: a.terminalId,
      hostId: a.hostId,
    };
  });
  agents.sort((a, b) => RANK[a.state] - RANK[b.state] || a.since - b.since || a.id.localeCompare(b.id));

  const rowsByPath = new Map(s.worktrees.map((w) => [w.path, w]));
  const worktrees: ApiWorktree[] = s.desks.map((d) => {
    const local = d.hostId === 'local' && !!d.path;
    const row = local ? rowsByPath.get(d.path) : undefined;
    return {
      id: d.key,
      orcaWorktreeId: row?.id ?? null,
      floorId: d.floorId,
      kind: d.kind,
      name: d.name,
      branch: d.branch ?? row?.branch ?? null,
      path: d.path,
      hostId: d.hostId,
      open: d.open,
      workspaceStatus: (local && s.kanbanByPath.get(d.path)) || null,
      unread: d.unread,
      lastActivityAt: d.lastActivityAt,
      comment: local ? texts.comment(d.path) : null,
      links: ((local && s.linksByPath.get(d.path)) || []).map(apiLink),
      servers: ((local && s.portsByPath.get(d.path)) || []).map(apiServer),
      isMain: row?.isMain ?? false,
      parentId: row?.parentId ?? null,
    };
  });
  worktrees.sort((a, b) => a.floorId.localeCompare(b.floorId) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const floors: ApiFloor[] = s.floors.map((f) => {
    const mine = agents.filter((a) => a.floorId === f.id);
    return {
      id: f.id,
      projectId: f.projectId,
      name: f.name,
      dir: f.dir,
      needsYou: mine.filter((a) => a.needsYou).length,
      working: mine.filter((a) => a.state === 'working').length,
      stuck: mine.filter((a) => a.stuck).length,
      done: mine.filter((a) => a.state === 'done').length,
    };
  });
  floors.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const bots: ApiBot[] = s.bots.map((b) => {
    const best = b.chats.reduce<OrcaState | null>((x, c) => (x === null || RANK[c.state] < RANK[x] ? c.state : x), null);
    const st: ApiBotState = b.paused ? 'paused' : best === 'working' ? 'working' : best === 'blocked' || best === 'waiting' ? 'needs_input' : 'idle';
    return {
      id: b.id,
      name: b.name,
      agent: b.agent,
      specialty: b.specialty,
      state: st,
      chats: b.chats.filter((c) => c.sessionId).map((c) => ({ id: c.sessionId!, state: c.state, lastActivityAt: c.updatedAt })),
    };
  });

  const runs: ApiRun[] = s.runs.map(({ run, live, coordinator }) => {
    const t = texts.run(run.id);
    return {
      id: run.id,
      objective: t?.objective ?? run.objective,
      live,
      updatedAt: run.updatedAt,
      tasks: run.tasks.map((k) => ({ id: k.id, status: k.status, title: t?.tasks.get(k.id) ?? k.title })),
      gates: run.gates.map((g) => {
        const full = t?.gates.get(g.id);
        return { id: g.id, taskId: g.taskId, question: full?.question ?? g.question, options: full?.options.length ? full.options : g.options };
      }),
      workers: run.workers.map((w) => ({ dispatchId: w.dispatchId, taskId: w.taskId, state: w.state, worktree: w.workspace, hostId: w.host })),
      coordinator,
    };
  });

  const rooms: ApiRoom[] = s.rooms.map((r) => ({
    id: r.id,
    source: r.source,
    runId: r.runId,
    name: (r.runId ? texts.run(r.runId)?.objective : null) ?? r.name,
    coordinator: r.coordinator,
    members: r.members,
  }));

  return {
    orca: { connected: input.connected, lastSnapshotAt: input.lastSnapshotAt },
    floors,
    worktrees,
    agents,
    bots,
    runs,
    usage: input.limits ? apiUsage(input.limits) : null,
    rooms,
  };
}

/**
 * A digest of the content: what `changed` events carry, and what tells a change from none. The time
 * of the plugin's last snapshot is left out: it moves every ~10 s while nothing else does.
 */
export function fingerprint(body: SnapshotBody): string {
  const stable = { ...body, orca: { ...body.orca, lastSnapshotAt: null } };
  return createHash('sha256').update(JSON.stringify(stable)).digest('base64url').slice(0, 22);
}

function apiLink(l: { provider: ApiLink['provider']; kind: ApiLink['kind']; ref: string; url?: string; title?: string }): ApiLink {
  const title = toBubble(l.title, LINK_TITLE);
  return { provider: l.provider, kind: l.kind, ref: l.ref, ...(l.url ? { url: l.url } : {}), ...(title ? { title } : {}) };
}

function apiServer(p: PortRow): ApiServer {
  return { port: p.port, host: p.host, pid: p.pid, command: p.command, url: p.url ?? `http://localhost:${p.port}`, ...(p.title ? { title: p.title } : {}), since: p.since };
}

function apiUsage(l: PlanLimits): ApiUsage {
  return {
    at: l.at,
    providers: l.providers.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      ...(p.plan ? { plan: p.plan } : {}),
      windows: p.windows.map((w) => ({ label: w.label, pct: w.pct, ...(w.resetsAt !== undefined ? { resetsAt: w.resetsAt } : {}) })),
      ...(p.resets !== undefined ? { resets: p.resets } : {}),
      at: p.at,
    })),
  };
}

/** Keeps `rev` and the digest: a new rev only when the content changed. */
export class SnapshotClock {
  rev = 0;
  private last = '';

  /** The full snapshot for this content and time; bumps `rev` if the content changed. */
  stamp(body: SnapshotBody, now: number): ApiSnapshot {
    const fp = fingerprint(body);
    if (fp !== this.last) {
      this.last = fp;
      this.rev++;
    }
    return { version: API_VERSION, at: now, rev: this.rev, fingerprint: fp, ...body };
  }
}
