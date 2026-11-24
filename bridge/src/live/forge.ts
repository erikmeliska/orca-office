/**
 * The repo-wide board (v2, design #17, issue #38): a floor's open issues and pull/merge requests,
 * read from its forge through a `ForgeAdapter`. First adapters: `gh` (GitHub) and `glab` (GitLab).
 *
 * - Read only: `gh issue list`, `gh pr list`, `glab issue list`, `glab mr list`, nothing else.
 * - `execFile` with an argument array (never a shell), a timeout, a capped output.
 * - The CLIs keep their own login; the bridge never reads, passes or logs a token. A failure is
 *   reported by kind only (`missing`, `auth`, `failed`), never with the CLI's output.
 * - Titles are cut with toBubble to ORCA_LINK_TITLE the moment they are read (design #20); the
 *   board lives in memory for FORGE_TTL_MS and is never written anywhere.
 */
import { execFile } from 'node:child_process';
import { toBubble } from '@orca-office/shared';
import { ORCA_LINK_TITLE, type OrcaForgeBoard, type OrcaForgeItem, type OrcaForgeStatus } from '@orca-office/shared/office/protocol/orca';
import { safeUrl } from './worktrees.js';

/** How long a floor's board is good for. */
export const FORGE_TTL_MS = 3 * 60_000;
/** After a failure, try again sooner than the TTL, but not on every page visit. */
export const FORGE_RETRY_MS = 60_000;
/** Items read per list (issues, pull/merge requests). */
export const FORGE_LIMIT = 30;
const CLI_TIMEOUT_MS = 15_000;

export type ForgeKind = 'github' | 'gitlab';

/** A repository on a forge, from its git remote. */
export interface ForgeRepo {
  kind: ForgeKind;
  /** `github.com`, `gitlab.com`, or a self-hosted forge's host. */
  host: string;
  /** `owner/name` (GitLab: `group/subgroup/name`). */
  path: string;
}

/** What a forge has open, before the office matches it with its worktrees. */
export interface ForgeLists {
  issues: ForgeItem[];
  pulls: ForgeItem[];
}

export interface ForgeItem {
  number: number;
  title: string;
  url?: string;
  /** A pull/merge request's source branch: a worktree on it counts as working on it. */
  branch?: string;
  draft?: boolean;
}

/** A forge CLI failed: why, by kind only. */
export class ForgeError extends Error {
  constructor(readonly code: Exclude<OrcaForgeStatus, 'ok' | 'loading'>) {
    super(code);
  }
}

export interface ForgeAdapter {
  readonly kind: ForgeKind;
  /** The CLI that answers for it (`gh`, `glab`), for the board's note. */
  readonly cli: string;
  list(repo: ForgeRepo): Promise<ForgeLists>;
}

/** Runs a CLI and parses its JSON stdout. Rejects with a ForgeError, never with what it printed. */
export type RunCli = (bin: string, args: string[]) => Promise<unknown>;

const AUTH_HINT = /auth login|not logged|unauthori[sz]ed|\b401\b|authentication|no token|token .*(invalid|expired)/i;

export function runCli(timeoutMs = CLI_TIMEOUT_MS): RunCli {
  return (bin, args) =>
    new Promise((resolve, reject) => {
      // No prompts, no pager, no colour: a CLI that wants to ask something fails instead.
      const env = { ...process.env, GH_PROMPT_DISABLED: '1', GLAB_NO_PROMPT: '1', NO_PROMPT: '1', PAGER: 'cat', GH_PAGER: 'cat', NO_COLOR: '1', CLICOLOR: '0' };
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === 'ENOENT') return reject(new ForgeError('missing'));
          // The stderr is looked at for a login hint and dropped: it is never logged or passed on.
          return reject(new ForgeError(AUTH_HINT.test(String(stderr)) ? 'auth' : 'failed'));
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new ForgeError('failed'));
        }
      });
    });
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const rows = (v: unknown): Obj[] => (Array.isArray(v) ? (v.map(obj).filter(Boolean) as Obj[]) : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
const branchName = (v: unknown): string | undefined => (typeof v === 'string' && v && v.length <= 250 ? v : undefined);

function item(n: number | null, title: unknown, url: unknown, extra: Partial<ForgeItem> = {}): ForgeItem | null {
  if (!n) return null;
  const u = safeUrl(url);
  return { number: n, title: toBubble(typeof title === 'string' ? title : '', ORCA_LINK_TITLE) || `#${n}`, ...(u ? { url: u } : {}), ...(extra.branch ? { branch: extra.branch } : {}), ...(extra.draft ? { draft: true } : {}) };
}

const nonNull = <T>(v: T | null): v is T => v !== null;

/** `gh` (GitHub): `-R host/owner/name`, so it works from any directory and on GitHub Enterprise. */
export function ghAdapter(run: RunCli = runCli(), bin = process.env.ORCA_OFFICE_GH || 'gh'): ForgeAdapter {
  return {
    kind: 'github',
    cli: 'gh',
    async list(repo) {
      const R = `${repo.host}/${repo.path}`;
      const [issues, pulls] = await Promise.all([
        run(bin, ['issue', 'list', '-R', R, '--state', 'open', '--limit', String(FORGE_LIMIT), '--json', 'number,title,url']),
        run(bin, ['pr', 'list', '-R', R, '--state', 'open', '--limit', String(FORGE_LIMIT), '--json', 'number,title,url,headRefName,isDraft']),
      ]);
      return {
        issues: rows(issues).map((r) => item(num(r.number), r.title, r.url)).filter(nonNull),
        pulls: rows(pulls).map((r) => item(num(r.number), r.title, r.url, { branch: branchName(r.headRefName), draft: r.isDraft === true })).filter(nonNull),
      };
    },
  };
}

/** `glab` (GitLab): `-R https://host/group/name`, which also names a self-hosted GitLab. */
export function glabAdapter(run: RunCli = runCli(), bin = process.env.ORCA_OFFICE_GLAB || 'glab'): ForgeAdapter {
  return {
    kind: 'gitlab',
    cli: 'glab',
    async list(repo) {
      const R = `https://${repo.host}/${repo.path}`;
      const [issues, mrs] = await Promise.all([
        run(bin, ['issue', 'list', '-R', R, '--per-page', String(FORGE_LIMIT), '--output', 'json']),
        run(bin, ['mr', 'list', '-R', R, '--per-page', String(FORGE_LIMIT), '--output', 'json']),
      ]);
      const open = (r: Obj) => r.state === undefined || r.state === 'opened';
      return {
        issues: rows(issues).filter(open).map((r) => item(num(r.iid), r.title, r.web_url)).filter(nonNull),
        pulls: rows(mrs)
          .filter(open)
          .map((r) => item(num(r.iid), r.title, r.web_url, { branch: branchName(r.source_branch), draft: r.draft === true || r.work_in_progress === true }))
          .filter(nonNull),
      };
    },
  };
}

/**
 * A git remote → its forge repository: `git@github.com:o/r.git`, `https://github.com/o/r`,
 * `ssh://git@gitlab.example.com:2222/g/s/r.git`. Null for anything else (a path, an unknown forge).
 */
export function parseRemote(remote: string): ForgeRepo | null {
  const s = remote.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(s);
  if (/^[a-z+]+:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(u.protocol)) return null;
    host = u.hostname;
    path = u.pathname;
  } else if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else return null;
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  host = host.toLowerCase();
  if (!/^[a-z0-9.-]{1,253}$/.test(host) || !/^[\w.-]+(\/[\w.-]+)+$/.test(path) || path.split('/').some((p) => p === '..' || p === '.')) return null;
  const kind: ForgeKind | null = host === 'github.com' || /(^|\.)github\./.test(host) ? 'github' : host === 'gitlab.com' || /(^|\.)gitlab\./.test(host) ? 'gitlab' : null;
  if (!kind) return null;
  if (kind === 'github' && path.split('/').length !== 2) return null;
  return { kind, host, path };
}

/** `git remote get-url origin` in a worktree (no shell, short timeout); null when there is none. */
export function gitRemote(bin = process.env.ORCA_OFFICE_GIT || 'git', timeoutMs = 3_000): (dir: string) => Promise<string | null> {
  return (dir) =>
    new Promise((resolve) => {
      execFile(bin, ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: timeoutMs, maxBuffer: 64 * 1024 }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
    });
}

/** What the office knows of a floor's repository: a local worktree to ask git in, and its worktrees' work. */
export interface ForgeTarget {
  floor: string;
  /** A local worktree of the repository (for `git remote`). */
  dir: string;
  /** Branches that have a worktree. */
  branches: Set<string>;
  /** What Orca links to its worktrees: `pr:12`, `issue:34` (GitLab MRs count as `pr`). */
  linked: Set<string>;
}

const NOTES: Record<Exclude<OrcaForgeStatus, 'ok'>, (cli: string) => string> = {
  loading: () => 'Reading the board…',
  missing: (cli) => `\`${cli}\` isn't installed: install it to see this repo's board.`,
  auth: (cli) => `\`${cli}\` isn't logged in: run \`${cli} auth login\` to see this repo's board.`,
  failed: (cli) => `\`${cli}\` couldn't read this repo's board. Trying again in a minute.`,
  no_remote: () => 'This repo has no remote on GitHub or GitLab, so there is no board.',
};

export function forgeNote(status: OrcaForgeStatus, cli: string): string | undefined {
  return status === 'ok' ? undefined : NOTES[status](cli);
}

/** A forge's lists matched with the office's worktrees: what has one, and the queue of what has none. */
export function boardOf(repo: ForgeRepo | null, cli: string, status: OrcaForgeStatus, lists: ForgeLists | null, t: ForgeTarget, fetchedAt: number): OrcaForgeBoard {
  const pr = repo?.kind === 'gitlab' ? 'mr' : 'pr';
  const mark = (kind: 'issue' | 'pr' | 'mr', i: ForgeItem): OrcaForgeItem => ({
    kind,
    ref: `${kind === 'mr' ? '!' : '#'}${i.number}`,
    number: i.number,
    title: i.title,
    ...(i.url ? { url: i.url } : {}),
    ...(i.draft ? { draft: true } : {}),
    worktree: t.linked.has(`${kind === 'issue' ? 'issue' : 'pr'}:${i.number}`) || (!!i.branch && t.branches.has(i.branch)),
  });
  const issues = (lists?.issues ?? []).map((i) => mark('issue', i));
  const pulls = (lists?.pulls ?? []).map((i) => mark(pr, i));
  const note = forgeNote(status, cli);
  return {
    provider: repo?.kind ?? null,
    repo: repo ? repo.path : null,
    status,
    ...(note ? { note } : {}),
    issues,
    pulls,
    queue: [...issues, ...pulls].filter((i) => !i.worktree),
    fetchedAt,
  };
}

interface Cached {
  repo: ForgeRepo | null;
  cli: string;
  status: OrcaForgeStatus;
  lists: ForgeLists | null;
  at: number;
}

export interface ForgeDeps {
  adapters: ForgeAdapter[];
  remote: (dir: string) => Promise<string | null>;
  now: () => number;
  /** A floor's board came in (or changed): tell the pages on it. */
  changed: (floor: string) => void;
}

/**
 * The boards of the floors pages are on: read when a page arrives on a floor whose board is older
 * than FORGE_TTL_MS (a failure: FORGE_RETRY_MS), one read per floor at a time. In memory only.
 */
export class ForgeBoards {
  private cache = new Map<string, Cached>();
  private running = new Set<string>();
  /** Each floor's repository by its worktree dir (git remotes don't change often; read once per dir). */
  private remotes = new Map<string, ForgeRepo | null>();

  constructor(private deps: ForgeDeps) {}

  /** The board for a floor now (from the cache, or "reading…"); starts a read when it is stale. */
  board(t: ForgeTarget): OrcaForgeBoard {
    const c = this.cache.get(t.floor);
    const now = this.deps.now();
    if (!c || now - c.at > (c.status === 'ok' ? FORGE_TTL_MS : FORGE_RETRY_MS)) void this.read(t);
    if (!c) return boardOf(null, '', 'loading', null, t, 0);
    return boardOf(c.repo, c.cli, c.status, c.lists, t, c.at);
  }

  private async read(t: ForgeTarget): Promise<void> {
    if (this.running.has(t.floor)) return;
    this.running.add(t.floor);
    try {
      let repo = this.remotes.get(t.dir);
      if (repo === undefined) {
        const url = await this.deps.remote(t.dir);
        repo = url ? parseRemote(url) : null;
        // Only a found repository is kept: no remote may be a hiccup, asked again on the next retry.
        if (repo) this.remotes.set(t.dir, repo);
      }
      const adapter = repo ? this.deps.adapters.find((a) => a.kind === repo!.kind) : undefined;
      let next: Cached;
      if (!repo || !adapter) next = { repo: repo ?? null, cli: '', status: 'no_remote', lists: null, at: this.deps.now() };
      else {
        try {
          next = { repo, cli: adapter.cli, status: 'ok', lists: await adapter.list(repo), at: this.deps.now() };
        } catch (err) {
          const prev = this.cache.get(t.floor);
          const status = err instanceof ForgeError ? err.code : 'failed';
          // A failed refresh keeps the last good lists on the board, with the note.
          next = { repo, cli: adapter.cli, status, lists: prev?.status === 'ok' ? prev.lists : null, at: this.deps.now() };
        }
      }
      this.cache.set(t.floor, next);
      this.deps.changed(t.floor);
    } finally {
      this.running.delete(t.floor);
    }
  }
}
