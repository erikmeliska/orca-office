/**
 * Orchestration Runs from the Orca CLI, read-only (design #27, #29; issues #29, #30, #33, #34).
 * Real shapes, checked on Orca 1.4.272 (docs/spike-m0.md #5):
 *
 *   run-list --json              result.runs[]: id, objective
 *   run-show --id R --full --json result.run: id, objective, coordinator_handle (null so far),
 *                                 legacy, created_at, updated_at (ISO)
 *   task-list --run R --json     result.tasks[]: id, status (pending | ready | dispatched |
 *                                 completed | failed | blocked), title
 *   gate-list --run R --json     result.gates[]: id, taskId, status (pending | resolved), question,
 *                                 options (a JSON array as a string, when there are any)
 *   worker-list --run R --json   result.workers[]: dispatchId, taskId, state, liveness, terminal,
 *                                 workspace (`<repoId>::<path>`), host
 *   inbox --limit N --json       result.messages[]: id, type, from, to (`run:R`, `dispatch:D`,
 *                                 `orca_session_id:S`, `structworker_…`), subject, body,
 *                                 payload.{taskId, dispatchId}, handled
 *
 * Private (design #20): objective, task titles, gate questions and options, message subjects are
 * cut with toBubble the moment they are read; message bodies are never read at all. Nothing here is
 * logged or written anywhere.
 */
import { toBubble } from '@orca-office/shared';

/** The longest private text the page gets from a Run (objective, task title, gate, subject). */
export const RUN_TEXT = 60;

export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked' | 'in_progress';
const TASK_STATUSES = new Set<TaskStatus>(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked', 'in_progress']);
/** A task still to be done (a Run with any of these is going on). */
export const OPEN_TASK = new Set<TaskStatus>(['pending', 'ready', 'dispatched', 'blocked', 'in_progress']);

export interface RunTask {
  id: string;
  status: TaskStatus;
  /** Cut to RUN_TEXT. */
  title: string | null;
}

export interface RunGate {
  id: string;
  taskId: string | null;
  /** Cut to RUN_TEXT. */
  question: string | null;
  /** Each cut to 40, at most 6. */
  options: string[];
}

export interface RunWorker {
  dispatchId: string;
  taskId: string | null;
  state: string | null;
  /** `<repoId>::<path>` of the worktree it works in. */
  workspace: string | null;
  host: string;
}

export interface OrcaRun {
  id: string;
  /** Cut to RUN_TEXT. */
  objective: string | null;
  coordinatorHandle: string | null;
  legacy: boolean;
  updatedAt: number;
  tasks: RunTask[];
  /** Pending gates only: the ones waiting for your decision. */
  gates: RunGate[];
  workers: RunWorker[];
}

export type HandoffKind = 'dispatch' | 'ask' | 'reply' | 'worker_done' | 'escalation';
const HANDOFFS = new Set(['ask', 'reply', 'worker_done', 'escalation', 'question', 'answer', 'handoff']);

export interface InboxMessage {
  id: string;
  /** What the office animates; null for other mail (`status`), which still tells who coordinates. */
  kind: HandoffKind | null;
  from: string;
  to: string;
  /** Cut to RUN_TEXT; the body is never read. */
  subject: string | null;
  dispatchId: string | null;
  taskId: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const id = (v: unknown): string | null => {
  const s = str(v);
  return s && s.length <= 200 && /^[\w.:@/-]+$/.test(s) ? s : null;
};
const result = (json: unknown): Obj | null => {
  const o = obj(json);
  if (o?.ok === false) return null;
  return obj(o?.result) ?? o;
};
const list = (json: unknown, key: string): Obj[] => {
  const r = result(json);
  const v = r?.[key];
  return Array.isArray(v) ? (v.map(obj).filter(Boolean) as Obj[]) : [];
};

export function parseRunList(json: unknown): { id: string }[] {
  return list(json, 'runs')
    .map((r) => id(r.id))
    .filter((x): x is string => !!x)
    .map((x) => ({ id: x }));
}

export function parseRunShow(json: unknown): Pick<OrcaRun, 'id' | 'objective' | 'coordinatorHandle' | 'legacy' | 'updatedAt'> | null {
  const run = obj(result(json)?.run);
  const runId = id(run?.id);
  if (!run || !runId) return null;
  const t = Date.parse(str(run.updated_at) ?? str(run.created_at) ?? '');
  return {
    id: runId,
    objective: toBubble(str(run.objective), RUN_TEXT),
    coordinatorHandle: id(run.coordinator_handle),
    legacy: run.legacy === 1 || run.legacy === true,
    updatedAt: Number.isFinite(t) ? t : 0,
  };
}

export function parseTasks(json: unknown): RunTask[] {
  const out: RunTask[] = [];
  for (const t of list(json, 'tasks')) {
    const taskId = id(t.id);
    const status = str(t.status) as TaskStatus | null;
    if (!taskId || !status || !TASK_STATUSES.has(status)) continue;
    out.push({ id: taskId, status, title: toBubble(str(t.title), RUN_TEXT) });
  }
  return out;
}

export function parseGates(json: unknown): RunGate[] {
  const out: RunGate[] = [];
  for (const g of list(json, 'gates')) {
    const gateId = id(g.id);
    if (!gateId || (str(g.status) ?? 'pending') !== 'pending') continue;
    let opts: unknown = g.options;
    if (typeof opts === 'string') {
      try {
        opts = JSON.parse(opts);
      } catch {
        opts = [];
      }
    }
    const options = (Array.isArray(opts) ? opts : [])
      .map((o) => toBubble(typeof o === 'string' ? o : str(obj(o)?.label), 40))
      .filter((o): o is string => !!o)
      .slice(0, 6);
    out.push({ id: gateId, taskId: id(g.taskId) ?? id(g.task_id), question: toBubble(str(g.question), RUN_TEXT), options });
  }
  return out;
}

export function parseWorkers(json: unknown): RunWorker[] {
  const out: RunWorker[] = [];
  for (const w of list(json, 'workers')) {
    const dispatchId = id(w.dispatchId);
    if (!dispatchId) continue;
    const ws = str(w.workspace);
    out.push({ dispatchId, taskId: id(w.taskId), state: str(w.state)?.slice(0, 24) ?? null, workspace: ws && ws.includes('::') && ws.length < 1000 ? ws : null, host: str(w.host) ?? 'local' });
  }
  return out;
}

export function parseInbox(json: unknown): InboxMessage[] {
  const out: InboxMessage[] = [];
  for (const m of list(json, 'messages')) {
    const msgId = id(m.id);
    const type = str(m.type);
    const from = str(m.from);
    const to = str(m.to);
    if (!msgId || !type || !from || !to || from.length > 200 || to.length > 200) continue;
    const kind: HandoffKind | null = !HANDOFFS.has(type) ? null : type === 'question' ? 'ask' : type === 'answer' ? 'reply' : type === 'handoff' ? 'dispatch' : (type as HandoffKind);
    const p = obj(m.payload);
    out.push({ id: msgId, kind, from, to, subject: toBubble(str(m.subject), RUN_TEXT), dispatchId: id(p?.dispatchId), taskId: id(p?.taskId) });
  }
  return out;
}

/** A Run the roof shows: one with open work or a pending gate, or one that changed lately. */
export function isLive(run: OrcaRun, now: number, recentMs: number): boolean {
  if (run.gates.length || run.tasks.some((t) => OPEN_TASK.has(t.status))) return true;
  return !run.legacy && run.tasks.length > 0 && now - run.updatedAt < recentMs;
}
