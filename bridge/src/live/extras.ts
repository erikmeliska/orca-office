/**
 * Orca's other corners, read on demand for a page (M7, roadmap B8, B9, B11):
 *
 * - B8 sessions search: `orca search --query=<q> --scope conversation --limit 12 --json`, for ⌘K once
 *   the page has typed 3 characters (it waits for a pause in the typing). Each hit's title and snippet
 *   are cut with toBubble the moment they are read; the session's path only finds its desk and is
 *   dropped. Nothing is kept but, per page, the last results' workspace ids (to open one in Orca).
 * - B9 automations: `orca automations list --json` and `runs --limit 50 --json`: name, schedule, the
 *   next run and the last one's outcome; never a prompt. "Run now" (`automations run <id>`) only for
 *   an automation of the last list, only with `confirm`, at most one every 30 s.
 * - B11 cleanup: `orca workspace cleanup preview --json`: what Orca's cleanup rules would remove and
 *   why. Running them (`workspace cleanup run`) needs `confirm: 'remove'` and the number of
 *   workspaces the page showed: the preview is read again first and anything different is refused.
 *
 * Every call: `execFile` with an argument array, no shell; failures are short codes; nothing is logged.
 */
import { toBubble } from '@orca-office/shared';
import type { OrcaAutomation, OrcaCleanupRow, OrcaSearchHit } from '@orca-office/shared/office/protocol/orca';
import type { ClientMsg, ServerMsg } from '@orca-office/shared/office/protocol';
import type { CallResult } from '../plugin-link.js';
import type { PageLimits } from '../rate.js';
import type { LiveModel } from './model.js';

export const SEARCH_MIN = 3;
export const SEARCH_MAX = 200;
export const SEARCH_LIMIT = 12;

export interface ExtrasDeps {
  /** `orca <args>`, JSON out; rejects with a short reason. */
  cli(args: string[]): Promise<unknown>;
  /** The same with a long timeout (a cleanup run). */
  cliLong(args: string[]): Promise<unknown>;
  call(method: string, params: unknown): Promise<CallResult>;
}

export interface ExtrasPage {
  send(msgs: ServerMsg[]): void;
  limits: PageLimits;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const result = (json: unknown): Obj | null => obj(obj(json)?.result) ?? obj(json);
const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);
const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A word Orca uses for a state or a cause: kept only when it is one. */
const word = (v: unknown): string | null => (typeof v === 'string' && /^[a-z][a-z0-9_-]{0,40}$/i.test(v) ? v : null);

const HANDLED = new Set(['orca.search', 'orca.search.open', 'orca.automations', 'orca.automations.run', 'orca.cleanup.preview', 'orca.cleanup.run']);

export class Extras {
  /** Per page: the workspace of each hit of its last search, and the automations of its last list. */
  private pages = new Map<ExtrasPage, { hits: (string | null)[]; automations: Set<string>; cleanup: number | null }>();

  constructor(
    private model: LiveModel,
    private deps: ExtrasDeps,
  ) {}

  static handles(t: string): boolean {
    return HANDLED.has(t);
  }

  closed(page: ExtrasPage): void {
    this.pages.delete(page);
  }

  async handle(page: ExtrasPage, msg: ClientMsg): Promise<void> {
    switch (msg.t) {
      case 'orca.search':
        return this.search(page, msg.reqId, msg.query);
      case 'orca.search.open':
        return this.openHit(page, msg.index);
      case 'orca.automations':
        return this.automations(page);
      case 'orca.automations.run':
        return this.runAutomation(page, msg.id, msg.confirm);
      case 'orca.cleanup.preview':
        return this.cleanupPreview(page);
      case 'orca.cleanup.run':
        return this.cleanupRun(page, msg.confirm, msg.expect);
    }
  }

  private state(page: ExtrasPage) {
    let s = this.pages.get(page);
    if (!s) this.pages.set(page, (s = { hits: [], automations: new Set(), cleanup: null }));
    return s;
  }

  private fail(page: ExtrasPage, action: 'search' | 'automations' | 'cleanup', error: string) {
    page.send([{ t: 'orca.result', action, ok: false, error }]);
  }

  // ---- B8: search ------------------------------------------------------------------------------

  private async search(page: ExtrasPage, reqId: unknown, query: unknown) {
    if (typeof reqId !== 'string' || !/^[A-Za-z0-9-]{1,40}$/.test(reqId) || typeof query !== 'string') return;
    const q = query.replace(/[\0\r\n]/g, ' ').trim();
    if (q.length < SEARCH_MIN || q.length > SEARCH_MAX) return void page.send([{ t: 'orca.search', reqId, hits: [] }]);
    if (!page.limits.other.take()) return this.fail(page, 'search', 'rate_limited');
    let json: unknown;
    try {
      // `--query=` as one argument: a query starting with "-" can't pass for a flag.
      json = await this.deps.cli(['search', `--query=${q}`, '--scope', 'conversation', '--limit', String(SEARCH_LIMIT), '--json']);
    } catch {
      return this.fail(page, 'search', 'cli_failed');
    }
    const st = this.state(page);
    const hits: OrcaSearchHit[] = [];
    st.hits = [];
    for (const h of (Array.isArray(result(json)?.hits) ? (result(json)!.hits as unknown[]) : []).slice(0, SEARCH_LIMIT)) {
      const o = obj(h);
      if (!o) continue;
      const cwd = str(o.cwd, 1000);
      const ws = cwd ? this.model.workspaceAt(cwd) : null;
      const seat = ws ? this.model.seatOfWorkspace(ws.id) : null;
      st.hits.push(ws?.id ?? null);
      hits.push({
        index: st.hits.length - 1,
        agent: word(o.agent) ?? 'agent',
        title: (toBubble(str(o.title, 2000) ?? '', 60) ?? '') || 'Untitled session',
        snippet: toBubble(str(obj(o.evidence)?.snippet, 4000) ?? '', 120) ?? '',
        ...(str(o.branch, 120) ? { branch: str(o.branch, 120)!.replace(/^refs\/heads\//, '') } : {}),
        ...(time(o.updatedAt) ? { updatedAt: time(o.updatedAt)! } : {}),
        ...(ws ? { worktree: ws.name } : {}),
        ...(seat ? { floor: seat.floor, deskId: seat.deskId } : {}),
        canOpen: !!ws,
      });
    }
    page.send([{ t: 'orca.search', reqId, hits }]);
  }

  /** Shows a hit's worktree in Orca (by its place in the page's last results: the page never names a workspace). */
  private async openHit(page: ExtrasPage, index: unknown) {
    if (typeof index !== 'number' || !Number.isInteger(index)) return;
    const id = this.pages.get(page)?.hits[index];
    if (!id) return this.fail(page, 'search', 'unknown_workspace');
    if (!page.limits.other.take()) return this.fail(page, 'search', 'rate_limited');
    const r = await this.deps.call('workspace.open', { workspaceId: id });
    page.send([{ t: 'orca.result', action: 'open', ok: r.ok, ...(r.ok ? {} : { error: r.error ?? 'failed' }) }]);
  }

  // ---- B9: automations -------------------------------------------------------------------------

  private async automations(page: ExtrasPage) {
    if (!page.limits.other.take()) return this.fail(page, 'automations', 'rate_limited');
    let list: unknown;
    let runs: unknown;
    try {
      [list, runs] = await Promise.all([this.deps.cli(['automations', 'list', '--json']), this.deps.cli(['automations', 'runs', '--limit', '50', '--json'])]);
    } catch {
      return this.fail(page, 'automations', 'cli_failed');
    }
    const last = new Map<string, Obj>();
    for (const r of Array.isArray(result(runs)?.runs) ? (result(runs)!.runs as unknown[]) : []) {
      const o = obj(r);
      const id = str(o?.automationId, 64);
      if (!o || !id) continue;
      const at = time(o.startedAt) ?? time(o.scheduledFor) ?? time(o.createdAt) ?? 0;
      const prev = last.get(id);
      if (!prev || at > (time(prev.startedAt) ?? time(prev.scheduledFor) ?? time(prev.createdAt) ?? 0)) last.set(id, o);
    }
    const st = this.state(page);
    st.automations = new Set();
    const items: OrcaAutomation[] = [];
    for (const a of Array.isArray(result(list)?.automations) ? (result(list)!.automations as unknown[]).slice(0, 100) : []) {
      const o = obj(a);
      const id = str(o?.id, 64);
      if (!o || !id || !UUID.test(id)) continue;
      st.automations.add(id);
      const r = last.get(id);
      items.push({
        id,
        name: (toBubble(str(o.name, 500) ?? '', 60) ?? '') || 'Automation',
        enabled: o.enabled === true,
        schedule: (str(o.rrule, 120) ?? '').replace(/[^\w ;=*/,:.-]/g, '').slice(0, 60),
        nextRunAt: time(o.nextRunAt),
        bot: !!obj(o.bot),
        ...(r
          ? {
              last: {
                status: word(r.status) ?? 'unknown',
                at: time(r.startedAt) ?? time(r.scheduledFor) ?? time(r.createdAt) ?? 0,
                ...(word(r.errorCode) ? { error: word(r.errorCode)! } : {}),
              },
            }
          : {}),
      });
    }
    items.sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
    page.send([{ t: 'orca.automations', items }]);
  }

  private async runAutomation(page: ExtrasPage, id: unknown, confirm: unknown) {
    if (typeof id !== 'string' || !UUID.test(id) || confirm !== true) return this.fail(page, 'automations', 'invalid');
    if (!this.pages.get(page)?.automations.has(id)) return this.fail(page, 'automations', 'unknown_automation');
    if (!page.limits.launch.take()) return this.fail(page, 'automations', 'rate_limited');
    try {
      await this.deps.cli(['automations', 'run', id, '--json']);
    } catch {
      return this.fail(page, 'automations', 'cli_failed');
    }
    page.send([{ t: 'orca.result', action: 'automations', ok: true }]);
  }

  // ---- B11: cleanup ----------------------------------------------------------------------------

  private async readCleanup(): Promise<{ evaluatedAt: number | null; remove: OrcaCleanupRow[]; keep: Record<string, number> }> {
    const json = await this.deps.cli(['workspace', 'cleanup', 'preview', '--json']);
    const remove: OrcaCleanupRow[] = [];
    const keep: Record<string, number> = {};
    for (const r of Array.isArray(result(json)?.rows) ? (result(json)!.rows as unknown[]) : []) {
      const o = obj(r);
      const ev = obj(o?.evaluation);
      if (!o || !ev) continue;
      const action = word(ev.action) ?? 'keep';
      const cause = word(ev.cause) ?? 'unknown';
      if (action === 'keep') {
        keep[cause] = (keep[cause] ?? 0) + 1;
        continue;
      }
      remove.push({
        name: (toBubble(str(o.displayName, 200) ?? '', 60) ?? '') || 'worktree',
        repo: toBubble(str(o.repoName, 200) ?? '', 40) ?? '',
        ...(str(o.branch, 200) ? { branch: toBubble(str(o.branch, 200)!.replace(/^refs\/heads\//, ''), 60) ?? '' } : {}),
        action,
        cause,
      });
    }
    return { evaluatedAt: time(result(json)?.evaluatedAt), remove, keep };
  }

  private async cleanupPreview(page: ExtrasPage) {
    if (!page.limits.other.take()) return this.fail(page, 'cleanup', 'rate_limited');
    try {
      const p = await this.readCleanup();
      this.state(page).cleanup = p.remove.length;
      page.send([{ t: 'orca.cleanup', ...p }]);
    } catch {
      this.fail(page, 'cleanup', 'cli_failed');
    }
  }

  /**
   * Runs Orca's cleanup rules (B11): only after the page showed the preview and was told twice, and
   * only while the preview still says the same number of workspaces would go.
   */
  private async cleanupRun(page: ExtrasPage, confirm: unknown, expect: unknown) {
    if (confirm !== 'remove' || typeof expect !== 'number' || !Number.isInteger(expect) || expect < 1) return this.fail(page, 'cleanup', 'invalid');
    if (this.pages.get(page)?.cleanup !== expect) return this.fail(page, 'cleanup', 'changed');
    if (!page.limits.launch.take()) return this.fail(page, 'cleanup', 'rate_limited');
    try {
      const now = await this.readCleanup();
      if (now.remove.length !== expect) {
        this.state(page).cleanup = now.remove.length;
        page.send([{ t: 'orca.cleanup', ...now }]);
        return this.fail(page, 'cleanup', 'changed');
      }
      await this.deps.cliLong(['workspace', 'cleanup', 'run', '--json']);
    } catch {
      return this.fail(page, 'cleanup', 'cli_failed');
    }
    this.state(page).cleanup = null;
    page.send([{ t: 'orca.result', action: 'cleanup', ok: true }]);
  }
}
