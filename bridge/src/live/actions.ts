/**
 * Light control from the office (M3, design #14): what an office page may make Orca do, checked
 * here before anything reaches the plugin (which checks its calls again, plugin/src/worker.ts).
 *
 * - Terminal agents on this machine: their live terminal (terminals.ts) and typing into it through
 *   `orca terminal send --text=…`, raw (Esc, Ctrl-C, Tab, arrows, Enter as `\r` arrive as they are),
 *   keystrokes that come while a send runs merged into the next one. Typing goes only to a terminal
 *   the page has open. (Plugin `terminal.sendText` is refused for any terminal outside the
 *   workspace active in Orca, checked on Orca 1.4.272, so it isn't used.)
 * - Open in Orca: `workspace.open`, then `terminal.focus` for a terminal agent.
 * - Mark read and the worktree comment: `orca worktree set` (the plugin API has neither).
 * - New task: `workspace.create` with an agent and a prompt in the floor's project; the page hears
 *   how it goes until the new figure sits down.
 *
 * Nothing here deletes, closes or merges. Rate limits per page (rate.ts). What is typed, prompts,
 * comments and terminal text are never logged or kept: errors carry short codes only.
 */
import { ORCA_AGENTS, ORCA_LIMITS, type OrcaActionKind } from '@orca-office/shared/office/protocol/orca';
import type { ClientMsg, ServerMsg } from '@orca-office/shared/office/protocol';
import type { CallResult } from '../plugin-link.js';
import type { PageLimits } from '../rate.js';
import type { LiveModel } from './model.js';
import type { TerminalWatch } from './terminals.js';

/** How long a new task's figure has to sit down before the page is told it's slow. */
export const CREATE_WAIT_MS = 120_000;
const CREATE_CALL_MS = 60_000;

export interface ActionDeps {
  call(method: string, params: unknown, timeoutMs?: number): Promise<CallResult>;
  /** `orca <args>` with JSON out; rejects with a short reason. */
  cli(args: string[]): Promise<unknown>;
  /**
   * Types into a terminal: `orca terminal send --terminal <id> --text=<text>` (raw bytes; with
   * `enter`, Orca submits it as a prompt). Plugin `terminal.sendText` only reaches terminals of the
   * workspace that is active in Orca right now, so the office types through the CLI. True, or a code.
   */
  send(terminalId: string, text: string, enter: boolean): Promise<true | string>;
  /** Ask the plugin for a fresh snapshot (a new workspace). */
  resync(): void;
  now(): number;
}

/** One office page, as the actions see it. */
export interface ActionPage {
  floor(): string | undefined;
  send(msgs: ServerMsg[]): void;
  limits: PageLimits;
}

interface PageState {
  /** The terminal open on this page: its figure, terminal and how to stop watching. */
  open: { workerId: string; terminalId: string; stop: () => void } | null;
  /** Typing waiting to go out, in order (merged while a send runs), and whether one is running. */
  out: { workerId: string; terminalId: string; text: string; enter: boolean }[];
  sending: boolean;
  /** Last time the page was told it typed too fast. */
  warnedAt: number;
}

interface PendingCreate {
  page: ActionPage;
  reqId: string;
  workspaceId: string | null;
  since: number;
}

const ACTIONS = new Set(['worker.attach', 'worker.detach', 'term.input', 'term.resize', 'worker.prompt', 'orca.open', 'orca.read', 'orca.comment', 'orca.desk', 'orca.create']);

export class Actions {
  private pages = new Map<ActionPage, PageState>();
  private creates: PendingCreate[] = [];

  constructor(
    private model: LiveModel,
    private deps: ActionDeps,
    private terminals: TerminalWatch,
  ) {}

  static handles(t: string): boolean {
    return ACTIONS.has(t);
  }

  /** The page closed: stop its terminal, forget its tasks. */
  closed(page: ActionPage): void {
    this.pages.get(page)?.open?.stop();
    this.pages.delete(page);
    this.creates = this.creates.filter((c) => c.page !== page);
  }

  async handle(page: ActionPage, msg: ClientMsg): Promise<void> {
    const st = this.state(page);
    switch (msg.t) {
      case 'worker.attach':
        return this.attach(page, st, msg.workerId);
      case 'worker.detach':
        if (st.open && st.open.workerId === msg.workerId) {
          st.open.stop();
          st.open = null;
        }
        return;
      case 'term.resize':
        // Orca sizes its own terminals; the page fits the text to its window.
        return;
      case 'term.input':
        return this.type(page, st, msg.workerId, msg.data, false);
      case 'worker.prompt':
        return this.prompt(page, st, msg.workerId, msg.prompt);
      case 'orca.open':
        return this.open(page, msg.workerId, msg.deskId);
      case 'orca.read':
        return this.markRead(page, msg.deskId);
      case 'orca.comment':
        return this.comment(page, msg.deskId, msg.comment);
      case 'orca.desk':
        return this.desk(page, msg.deskId);
      case 'orca.create':
        return this.create(page, msg);
    }
  }

  /** On every change to the building: a new task whose figure sat down is ready; one that took too long, failed. */
  tick(): void {
    const now = this.deps.now();
    this.creates = this.creates.filter((c) => {
      const seat = c.workspaceId ? this.model.seatOfWorkspace(c.workspaceId) : null;
      if (seat) {
        c.page.send([{ t: 'orca.create', reqId: c.reqId, phase: 'ready', floor: seat.floor, deskId: seat.deskId }]);
        return false;
      }
      if (now - c.since > CREATE_WAIT_MS) {
        c.page.send([{ t: 'orca.create', reqId: c.reqId, phase: 'failed', error: 'no_agent_yet' }]);
        return false;
      }
      return true;
    });
  }

  // ---- terminal -------------------------------------------------------------------------------

  private attach(page: ActionPage, st: PageState, workerId: unknown) {
    if (typeof workerId !== 'string') return;
    st.open?.stop();
    st.open = null;
    const t = this.model.target(workerId);
    if (!t?.terminalId) return void page.send([result('terminal', false, t ? (t.local ? 'no_terminal' : 'remote') : 'unknown_worker', { workerId })]);
    const terminalId = t.terminalId;
    st.open = { workerId, terminalId, stop: this.terminals.watch(terminalId, { workerId, send: (m) => page.send(m) }) };
  }

  /** Typing into the open terminal (`term.input`), in order, split to the worker's 4096-char sends. */
  private type(page: ActionPage, st: PageState, workerId: unknown, data: unknown, _enter: boolean) {
    if (typeof workerId !== 'string' || typeof data !== 'string' || data.length === 0) return;
    if (!st.open || st.open.workerId !== workerId) return void page.send([result('type', false, 'not_open', { workerId })]);
    if (data.length > ORCA_LIMITS.send * 8) return void page.send([result('type', false, 'too_large', { workerId })]);
    if (!this.allowTyping(page, st, data.length)) return;
    this.enqueue(page, st, workerId, st.open.terminalId, data, false);
  }

  /** A prompt (P at the desk): its text, then Enter, into the figure's terminal. */
  private prompt(page: ActionPage, st: PageState, workerId: unknown, prompt: unknown) {
    if (typeof workerId !== 'string' || typeof prompt !== 'string' || !prompt.trim()) return;
    if (prompt.length > ORCA_LIMITS.prompt) return void page.send([result('type', false, 'too_large', { workerId })]);
    const t = this.model.target(workerId);
    if (!t?.terminalId) return void page.send([result('type', false, t ? (t.local ? 'no_terminal' : 'remote') : 'unknown_worker', { workerId })]);
    if (!this.allowTyping(page, st, prompt.length)) return;
    this.enqueue(page, st, workerId, t.terminalId, prompt, true);
  }

  private allowTyping(page: ActionPage, st: PageState, n: number): boolean {
    if (page.limits.keys.take(1) && page.limits.bytes.take(n)) return true;
    const now = this.deps.now();
    if (now - st.warnedAt > 1000) {
      st.warnedAt = now;
      page.send([result('type', false, 'rate_limited')]);
    }
    return false;
  }

  /**
   * Queues text for a terminal. Raw typing joins the last queued piece for the same terminal (up to
   * 4096 chars), so a burst of keystrokes is one CLI call, not one each; a prompt goes on its own.
   */
  private enqueue(page: ActionPage, st: PageState, workerId: string, terminalId: string, text: string, enter: boolean) {
    // A NUL can't go through a process argument; nothing types one anyway.
    const clean = text.replace(/\0/g, '');
    if (!clean && !enter) return;
    const parts = enter ? [clean] : chunks(clean, ORCA_LIMITS.send);
    for (const part of parts) {
      const last = st.out.at(-1);
      if (!enter && last && !last.enter && last.terminalId === terminalId && last.text.length + part.length <= ORCA_LIMITS.send) last.text += part;
      else st.out.push({ workerId, terminalId, text: part, enter });
    }
    void this.pump(page, st);
  }

  private async pump(page: ActionPage, st: PageState) {
    if (st.sending) return;
    st.sending = true;
    try {
      while (st.out.length) {
        const s = st.out.shift()!;
        const r = await this.deps.send(s.terminalId, s.text, s.enter);
        if (r !== true) page.send([result('type', false, r, { workerId: s.workerId })]);
        else this.terminals.nudge(s.terminalId);
      }
    } finally {
      st.sending = false;
    }
  }

  // ---- Orca actions ---------------------------------------------------------------------------

  private async open(page: ActionPage, workerId: unknown, deskId: unknown) {
    if (!this.allow(page, 'open')) return;
    let workspaceId: string | null = null;
    let terminalId: string | null = null;
    if (typeof workerId === 'string') {
      const t = this.model.target(workerId);
      if (!t || !t.local) return void page.send([result('open', false, t ? 'remote' : 'unknown_worker', { workerId })]);
      workspaceId = t.workspaceId;
      terminalId = t.terminalId;
    } else if (typeof deskId === 'string') {
      workspaceId = this.deskWorkspace(page, deskId)?.id ?? null;
    }
    if (!workspaceId) return void page.send([result('open', false, 'unknown_workspace', ids(workerId, deskId))]);
    const r = await this.deps.call('workspace.open', { workspaceId });
    if (r.ok && terminalId) {
      const f = await this.deps.call('terminal.focus', { terminalId });
      return void page.send([result('open', f.ok, f.ok ? undefined : (f.error ?? 'failed'), ids(workerId, deskId))]);
    }
    page.send([result('open', r.ok, r.ok ? undefined : (r.error ?? 'failed'), ids(workerId, deskId))]);
  }

  private async markRead(page: ActionPage, deskId: unknown) {
    if (typeof deskId !== 'string' || !this.allow(page, 'read')) return;
    const ws = this.deskWorkspace(page, deskId);
    if (!ws) return void page.send([result('read', false, 'unknown_workspace', { deskId })]);
    const ok = await this.worktreeSet(ws.id, ws.kind, ['--read']);
    page.send([result('read', ok === true, ok === true ? undefined : ok, { deskId })]);
    if (ok === true) this.deps.resync();
  }

  private async comment(page: ActionPage, deskId: unknown, comment: unknown) {
    if (typeof deskId !== 'string' || typeof comment !== 'string' || !this.allow(page, 'comment')) return;
    if (comment.length > ORCA_LIMITS.comment || /[\0]/.test(comment)) return void page.send([result('comment', false, 'invalid', { deskId })]);
    const ws = this.deskWorkspace(page, deskId);
    if (!ws) return void page.send([result('comment', false, 'unknown_workspace', { deskId })]);
    // `--comment=<text>` as one argument (no shell): text starting with "-" can't pass for a flag.
    const ok = await this.worktreeSet(ws.id, ws.kind, [`--comment=${comment.trim()}`]);
    page.send([result('comment', ok === true, ok === true ? undefined : ok, { deskId })]);
  }

  private async desk(page: ActionPage, deskId: unknown) {
    if (typeof deskId !== 'string' || !this.allow(page, 'comment')) return;
    const ws = this.deskWorkspace(page, deskId);
    if (!ws) return void page.send([result('comment', false, 'unknown_workspace', { deskId })]);
    try {
      const json = (await this.deps.cli(['worktree', 'show', '--worktree', ws.id, '--json'])) as { result?: { worktree?: Record<string, unknown> }; worktree?: Record<string, unknown> };
      const w = json?.result?.worktree ?? json?.worktree ?? (json as { result?: Record<string, unknown> })?.result;
      const comment = typeof w?.comment === 'string' ? w.comment.slice(0, ORCA_LIMITS.comment) : '';
      page.send([{ t: 'orca.desk', deskId, comment, unread: w?.isUnread === true }]);
    } catch {
      page.send([result('comment', false, 'cli_failed', { deskId })]);
    }
  }

  private async create(page: ActionPage, msg: Extract<ClientMsg, { t: 'orca.create' }>) {
    const { reqId, floor, agent, prompt, name } = msg;
    if (typeof reqId !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(reqId)) return;
    const fail = (error: string) => page.send([{ t: 'orca.create', reqId, phase: 'failed', error }]);
    if (typeof floor !== 'string' || typeof agent !== 'string' || typeof prompt !== 'string') return fail('invalid');
    if (!(ORCA_AGENTS as readonly string[]).includes(agent)) return fail('unknown_agent');
    if (!prompt.trim() || prompt.length > ORCA_LIMITS.prompt) return fail('invalid_prompt');
    if (name !== undefined && (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(name))) return fail('invalid_name');
    const project = this.model.floorProject(floor);
    if (!project) return fail('no_project');
    if (!page.limits.create.take()) return fail('rate_limited');
    page.send([{ t: 'orca.create', reqId, phase: 'creating' }]);
    const r = await this.deps.call('workspace.create', { projectId: project.projectId, agent, prompt, ...(name ? { name } : {}) }, CREATE_CALL_MS);
    const value = r.value as { workspaceId?: unknown } | undefined;
    if (!r.ok || typeof value?.workspaceId !== 'string') return fail(r.error ?? 'failed');
    page.send([{ t: 'orca.create', reqId, phase: 'created' }]);
    this.creates.push({ page, reqId, workspaceId: value.workspaceId, since: this.deps.now() });
    this.deps.resync();
  }

  // ---- helpers --------------------------------------------------------------------------------

  private state(page: ActionPage): PageState {
    let st = this.pages.get(page);
    if (!st) this.pages.set(page, (st = { open: null, out: [], sending: false, warnedAt: -Infinity }));
    return st;
  }

  private allow(page: ActionPage, action: OrcaActionKind): boolean {
    if (page.limits.other.take()) return true;
    page.send([result(action, false, 'rate_limited')]);
    return false;
  }

  private deskWorkspace(page: ActionPage, deskId: string) {
    const floor = page.floor();
    if (!floor || typeof deskId !== 'string' || deskId.length > 64) return null;
    const ws = this.model.deskWorkspace(floor, deskId);
    return ws && (ws.hostId ?? 'local') === 'local' ? ws : null;
  }

  /** `orca worktree set` on a workspace; true, or a short error code. */
  private async worktreeSet(id: string, kind: 'worktree' | 'folder', flags: string[]): Promise<true | string> {
    if (kind !== 'worktree' && kind !== 'folder') return 'invalid';
    try {
      await this.deps.cli(['worktree', 'set', '--worktree', id, ...flags, '--json']);
      return true;
    } catch {
      return 'cli_failed';
    }
  }
}

function result(action: OrcaActionKind, ok: boolean, error?: string, extra: { workerId?: string; deskId?: string } = {}): ServerMsg {
  return { t: 'orca.result', action, ok, ...(error ? { error } : {}), ...extra };
}

function ids(workerId: unknown, deskId: unknown): { workerId?: string; deskId?: string } {
  return { ...(typeof workerId === 'string' ? { workerId } : {}), ...(typeof deskId === 'string' ? { deskId } : {}) };
}

/** Text in pieces of at most `n` characters, never splitting a surrogate pair. */
export function chunks(text: string, n: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + n);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}
