/**
 * The private texts the Office API gives in full (design #20, docs/api.md): an agent's last words and
 * title, a Run's objective, its tasks' titles and its gates' questions and options, a worktree's
 * comment. The office page never gets them (it gets bubbles cut at parse time, orca.ts / runs.ts);
 * only an authenticated local process does, through /api/v1.
 *
 * Kept in this process's memory only, replaced on every read and dropped with what they belong to.
 * Never logged, written to disk or put in an error: nothing here has a toString that prints them, and
 * the bridge logs CLI failures by kind only.
 *
 * They are read from the same CLI answers the office already reads (tap() below sees each answer once,
 * before the office's own parser cuts it), and from the plugin's `agent.status.changed` events (title).
 */
import type { RunJson } from '../live/cli.js';

/** Longest private text kept: Orca gives ≤200 characters for last words; titles and objectives are short. */
export const PRIVATE_MAX = 4_000;
const OPTIONS_MAX = 12;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const result = (json: unknown): Obj | null => {
  const o = obj(json);
  if (o?.ok === false) return null;
  return obj(o?.result) ?? o;
};
const rows = (json: unknown, key: string): Obj[] => {
  const v = result(json)?.[key];
  return Array.isArray(v) ? (v.map(obj).filter(Boolean) as Obj[]) : [];
};
const key = (v: unknown): string | null => (typeof v === 'string' && v !== '' && v.length <= 1000 ? v : null);

/** Private text as given, minus control characters other than newlines and tabs; null when empty. */
export function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!s) return null;
  const chars = Array.from(s);
  return chars.length <= PRIVATE_MAX ? s : chars.slice(0, PRIVATE_MAX).join('');
}

export interface AgentTexts {
  title: string | null;
  lastMessage: string | null;
}

export interface RunTexts {
  objective: string | null;
  tasks: Map<string, string>;
  gates: Map<string, { question: string | null; options: string[] }>;
}

export class PrivateTexts {
  /** By host, then pane key: from that host's `orca agent list`. */
  private agentsByHost = new Map<string, Map<string, AgentTexts>>();
  /** Titles from the plugin's status events, by pane key (local agents; the CLI's, when it has one, wins). */
  private eventTitles = new Map<string, string>();
  private runs = new Map<string, RunTexts>();
  /** By worktree path (this machine). */
  private comments = new Map<string, string>();

  /** `orca agent list --json` for one host (`local`, or an environment's name). */
  agentList(hostId: string, json: unknown): void {
    const next = new Map<string, AgentTexts>();
    for (const a of rows(json, 'agents')) {
      const pane = key(a.paneKey);
      if (!pane) continue;
      next.set(pane, { title: cleanText(a.title), lastMessage: cleanText(a.lastAssistantMessage) });
    }
    this.agentsByHost.set(hostId, next);
    if (hostId === 'local') for (const p of this.eventTitles.keys()) if (!next.has(p)) this.eventTitles.delete(p);
  }

  /** An `agent.status.changed` payload from the plugin: its title, if any. */
  statusEvent(payload: unknown): void {
    const o = obj(payload);
    const pane = key(o?.paneKey);
    const title = cleanText(o?.title);
    if (pane && title) this.eventTitles.set(pane, title);
  }

  agent(hostId: string, paneKey: string): AgentTexts {
    const t = this.agentsByHost.get(hostId)?.get(paneKey);
    return { title: t?.title ?? this.eventTitles.get(paneKey) ?? null, lastMessage: t?.lastMessage ?? null };
  }

  /** `orchestration run-show --full --json`. */
  runShow(json: unknown): void {
    const run = obj(result(json)?.run);
    const id = key(run?.id);
    if (!run || !id) return;
    this.runOf(id).objective = cleanText(run.objective);
  }

  /** `orchestration task-list --run R --json`. */
  taskList(runId: string, json: unknown): void {
    const tasks = new Map<string, string>();
    for (const t of rows(json, 'tasks')) {
      const id = key(t.id);
      const title = cleanText(t.title);
      if (id && title) tasks.set(id, title);
    }
    this.runOf(runId).tasks = tasks;
  }

  /** `orchestration gate-list --run R --json`. */
  gateList(runId: string, json: unknown): void {
    const gates = new Map<string, { question: string | null; options: string[] }>();
    for (const g of rows(json, 'gates')) {
      const id = key(g.id);
      if (!id) continue;
      let opts: unknown = g.options;
      if (typeof opts === 'string') {
        try {
          opts = JSON.parse(opts);
        } catch {
          opts = [];
        }
      }
      const options = (Array.isArray(opts) ? opts : [])
        .map((o) => cleanText(typeof o === 'string' ? o : obj(o)?.label))
        .filter((o): o is string => !!o)
        .slice(0, OPTIONS_MAX);
      gates.set(id, { question: cleanText(g.question), options });
    }
    this.runOf(runId).gates = gates;
  }

  run(runId: string): RunTexts | null {
    return this.runs.get(runId) ?? null;
  }

  /** Only the Runs the office still reads are kept. */
  keepRuns(ids: Iterable<string>): void {
    const keep = new Set(ids);
    for (const id of this.runs.keys()) if (!keep.has(id)) this.runs.delete(id);
  }

  /** `orca worktree list --json`: each worktree's comment, by path. */
  worktreeList(json: unknown): void {
    const next = new Map<string, string>();
    for (const w of rows(json, 'worktrees')) {
      const path = key(w.path) ?? key(obj(w.git)?.path);
      const comment = cleanText(w.comment);
      if (path && comment) next.set(path, comment);
    }
    this.comments = next;
  }

  comment(path: string): string | null {
    return this.comments.get(path) ?? null;
  }

  private runOf(id: string): RunTexts {
    let r = this.runs.get(id);
    if (!r) this.runs.set(id, (r = { objective: null, tasks: new Map(), gates: new Map() }));
    return r;
  }

  /**
   * A RunJson that hands the CLI's answers the office polls anyway to this store, then to the caller
   * unchanged. Errors pass through as they are (they never carry the output, cli.ts).
   */
  tap(run: RunJson): RunJson {
    return async (args) => {
      const json = await run(args);
      try {
        this.see(args, json);
      } catch {
        // A shape the store doesn't know: the office's own parser still gets the answer.
      }
      return json;
    };
  }

  private see(args: string[], json: unknown): void {
    const [a, b] = args;
    const flag = (name: string) => {
      const i = args.indexOf(name);
      return i >= 0 ? (args[i + 1] ?? null) : null;
    };
    if (a === 'agent' && b === 'list') return this.agentList(flag('--environment') ?? 'local', json);
    if (a === 'worktree' && b === 'list') return this.worktreeList(json);
    if (a !== 'orchestration') return;
    if (b === 'run-show') return this.runShow(json);
    const run = flag('--run');
    if (!run) return;
    if (b === 'task-list') return this.taskList(run, json);
    if (b === 'gate-list') return this.gateList(run, json);
  }

  /** Never print what is in here. */
  toJSON(): string {
    return '[private texts]';
  }
}
