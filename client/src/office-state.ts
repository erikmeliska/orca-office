/**
 * Plain model of what Orca reports, built from the bridge's snapshot and
 * event messages. The 3D office (M2) will render the same model.
 */
export type AgentState = 'working' | 'blocked' | 'waiting' | 'done';

export interface Agent {
  key: string;
  agent: string | null;
  state: AgentState;
  /** Chat agents (Orca chats, bots) have no terminal. */
  surface: 'terminal' | 'chat';
  since: number;
}

export interface Workspace {
  id: string;
  name: string;
  project: string;
  branch: string | null;
  hostId: string | null;
  kind: 'worktree' | 'folder';
  status: string;
  unread: boolean;
  lastActivityAt: number | null;
  agents: Map<string, Agent>;
}

export interface Office {
  workspaces: Map<string, Workspace>;
  snapshotAt: number | null;
}

export function emptyOffice(): Office {
  return { workspaces: new Map(), snapshotAt: null };
}

interface SnapshotWorkspace {
  id: string;
  kind: 'worktree' | 'folder';
  name: string;
  project?: string | null;
  branch: string | null;
  hostId: string | null;
  status?: { state: string; unread: boolean; lastActivityAt: number | null };
}

interface SnapshotAgent {
  terminalId: string | null;
  agent: string | null;
  state: AgentState;
  stateStartedAt: number;
  sessionId?: string | null;
}

export interface SnapshotMessage {
  type: 'snapshot';
  at: number;
  workspaces: SnapshotWorkspace[];
  agents: Record<string, SnapshotAgent[] | { error: string }>;
}

export interface StatusEvent {
  type: 'event';
  name: 'agent.status.changed';
  payload: {
    workspaceListId?: string;
    paneKey: string;
    terminalId?: string;
    state: AgentState;
    sessionId?: string | null;
    receivedAt: number;
  };
}

function agentKey(sessionId: string | null | undefined, terminalId: string | null | undefined, fallback: string): string {
  return sessionId ?? terminalId ?? fallback;
}

export function applySnapshot(office: Office, msg: SnapshotMessage): Office {
  const workspaces = new Map<string, Workspace>();
  for (const w of msg.workspaces) {
    const agents = new Map<string, Agent>();
    const list = msg.agents[w.id];
    if (Array.isArray(list)) {
      list.forEach((a, i) => {
        const key = agentKey(a.sessionId, a.terminalId, `${w.id}#${i}`);
        agents.set(key, {
          key,
          agent: a.agent,
          state: a.state,
          surface: a.terminalId ? 'terminal' : 'chat',
          since: a.stateStartedAt,
        });
      });
    }
    workspaces.set(w.id, {
      id: w.id,
      name: w.name,
      project: w.project ?? (w.kind === 'folder' ? 'Folders' : 'Other'),
      branch: w.branch,
      hostId: w.hostId,
      kind: w.kind,
      status: w.status?.state ?? 'inactive',
      unread: w.status?.unread ?? false,
      lastActivityAt: w.status?.lastActivityAt ?? null,
      agents,
    });
  }
  return { workspaces, snapshotAt: msg.at };
}

/** Applies one status change; repeated identical states change nothing. */
export function applyStatus(office: Office, ev: StatusEvent): boolean {
  const p = ev.payload;
  if (!p.workspaceListId) return false;
  const ws = office.workspaces.get(p.workspaceListId);
  if (!ws) return false;
  const key = agentKey(p.sessionId, p.terminalId, p.paneKey);
  const prev = ws.agents.get(key);
  if (prev && prev.state === p.state) return false;
  ws.agents.set(key, {
    key,
    agent: prev?.agent ?? null,
    state: p.state,
    surface: p.terminalId ? 'terminal' : 'chat',
    since: p.receivedAt,
  });
  if (p.state === 'working') ws.status = 'working';
  return true;
}

const RANK: Record<string, number> = { blocked: 0, waiting: 0, working: 1, done: 2 };

/** needs you < working < done < idle, then most recent activity first. */
export function workspaceRank(ws: Workspace): number {
  let best = 3;
  for (const a of ws.agents.values()) best = Math.min(best, RANK[a.state] ?? 3);
  return best;
}

export function needsYou(state: AgentState): boolean {
  return state === 'blocked' || state === 'waiting';
}
