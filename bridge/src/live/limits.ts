/**
 * The plan limits of the accounts the office's workers run on, per provider, read the way Orca's
 * usage view shows them (docs/usage.md), but only through the providers' own CLIs:
 *
 * - Claude: Claude Code answers a `get_usage` control request on its stream-json protocol with the
 *   numbers its /usage screen shows. Asking starts no conversation and costs nothing; Claude Code
 *   deals with its sign-in itself. Taken from agent-office's src/server/limits.ts @ 852e2ab (MIT,
 *   see NOTICE).
 * - Codex: `codex app-server` answers `account/read` and `account/rateLimits/read` over JSON-RPC on
 *   stdio, as Orca's own probe does (`codex-rpc-rate-limit-probe.ts`). No thread is started.
 *
 * The office never reads a token, a keychain item or an auth file, and never signs in: a CLI that
 * isn't signed in is shown as such. What a CLI prints is parsed here and dropped; only numbers and
 * the plan's name leave this file (no e-mail, no account id), and failures are logged by kind only.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LimitsProviderId, LimitsStatus, PlanLimits, PlanWindow, ProviderLimits } from '@orca-office/shared/office/protocol';

/** While a page is open. */
export const POLL_MS = 2 * 60_000;
/** Someone walking in, or clicking the meter, reads again, at most this often. */
export const MIN_GAP_MS = 20_000;
const TIMEOUT_MS = 30_000;
/** No plan limits (an API key), not signed in or not installed: look again much later. */
export const IDLE_MS = 30 * 60_000;
/** After this many failed reads in a row, wait longer. */
const FAILS_BEFORE_BACKOFF = 3;
export const BACKOFF_MS = 10 * 60_000;
const LABEL_MAX = 24;
/** A CLI's answer is a few kB; anything past this is not one. */
const MAX_OUTPUT = 1024 * 1024;

const NAMES: Record<LimitsProviderId, string> = { claude: 'Claude', codex: 'Codex' };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clampPct = (n: number) => Math.max(0, Math.min(100, n));
const label = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, LABEL_MAX) : undefined);

/** What one read found; `at` is filled in by the reader. */
export type Reading = Omit<ProviderLimits, 'id' | 'name' | 'at'>;

const failed = (status: Exclude<LimitsStatus, 'ok' | 'loading'>, plan?: string): Reading => ({ status, windows: [], ...(plan ? { plan } : {}) });

// ---- Claude ----------------------------------------------------------------------------------

function claudeWindow(name: string, w: unknown): PlanWindow | null {
  const o = obj(w);
  const pct = finite(o?.utilization);
  if (pct === null) return null;
  const resetsAt = typeof o?.resets_at === 'string' ? Date.parse(o.resets_at) : Number.NaN;
  return { label: name, pct: clampPct(pct), ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) };
}

/** Claude Code's `get_usage` answer, or null when it gave none. */
export function parseClaudeUsage(answer: unknown): Reading {
  const a = obj(answer);
  if (!a) return failed('error');
  const plan = label(a.subscription_type);
  const rl = obj(a.rate_limits);
  // An API key, Bedrock or Vertex (or no sign-in, which Claude Code reports the same way).
  if (a.rate_limits_available === false || !rl) return failed('no-plan', plan);
  const windows = [claudeWindow('5h session', rl.five_hour), claudeWindow('Week', rl.seven_day)];
  if (Array.isArray(rl.model_scoped)) {
    for (const m of rl.model_scoped) {
      const name = label(obj(m)?.display_name);
      if (name) windows.push(claudeWindow(`${name} week`, m));
    }
  } else {
    // Claude Code before per-model buckets.
    windows.push(claudeWindow('Opus week', rl.seven_day_opus), claudeWindow('Sonnet week', rl.seven_day_sonnet));
  }
  return { status: 'ok', ...(plan ? { plan } : {}), windows: windows.filter((w): w is PlanWindow => w !== null) };
}

export const CLAUDE_ARGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--tools', '',
  // Not the user's or the project's settings: no hooks, no MCP servers, no plugins, no transcript.
  '--setting-sources', '',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-session-persistence',
];

const CLAUDE_REQUEST = JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n';

/** The environment for a probe: the bridge's own, minus anything that marks a child session. */
export function probeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, NO_COLOR: '1' };
  for (const k of Object.keys(out)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CODEX_THREAD_ID') delete out[k];
  return out;
}

// ---- Codex -----------------------------------------------------------------------------------

const SESSION_MIN = 300;
const WEEK_MIN = 10_080;

function codexWindow(w: unknown, fallback: 'session' | 'week'): PlanWindow & { kind: 'session' | 'week' | 'other' } | null {
  const o = obj(w);
  const pct = finite(o?.usedPercent);
  if (pct === null) return null;
  const mins = finite(o?.windowDurationMins);
  // Older app-servers drift by a minute; an unknown length keeps primary = session, secondary = week.
  const kind = mins === null ? fallback : Math.abs(mins - SESSION_MIN) <= 1 ? 'session' : Math.abs(mins - WEEK_MIN) <= 1 ? 'week' : 'other';
  const reset = finite(o?.resetsAt);
  const what = kind === 'session' ? '5h session' : kind === 'week' ? 'Week' : mins! % 1440 === 0 ? `${mins! / 1440}d` : `${Math.round(mins! / 60)}h`;
  // Codex reset epochs are seconds.
  return { kind, label: what, pct: clampPct(pct), ...(reset && reset > 0 ? { resetsAt: reset * 1000 } : {}) };
}

function codexWindows(snap: unknown, prefix?: string): PlanWindow[] {
  const s = obj(snap);
  if (!s) return [];
  const ws = [codexWindow(s.primary, 'session'), codexWindow(s.secondary, 'week')].filter((w) => w !== null);
  ws.sort((a, b) => (a.kind === 'session' ? 0 : a.kind === 'week' ? 1 : 2) - (b.kind === 'session' ? 0 : b.kind === 'week' ? 1 : 2));
  // A workspace seat may report only a monthly spend cap.
  const cap = obj(s.individualLimit);
  const left = finite(cap?.remainingPercent);
  if (!ws.length && left !== null) {
    const reset = finite(cap?.resetsAt);
    ws.push({ kind: 'other', label: 'Month', pct: clampPct(100 - left), ...(reset && reset > 0 ? { resetsAt: reset * 1000 } : {}) });
  }
  return ws.map(({ kind: _kind, ...w }) => (prefix ? { ...w, label: `${prefix} ${w.label === '5h session' ? '5h' : w.label.toLowerCase()}`.slice(0, LABEL_MAX + 8) } : w));
}

/**
 * `account/read` and `account/rateLimits/read` answers of `codex app-server`. `account` is null when
 * Codex is not signed in; the rate limits are only asked for a ChatGPT sign-in.
 */
export function parseCodexUsage(account: unknown, limits: unknown): Reading {
  const acc = obj(obj(account)?.account);
  if (!acc) return failed('signed-out');
  const accPlan = label(acc.planType);
  if (acc.type === 'apiKey') return failed('no-plan');
  const r = obj(limits);
  const main = obj(r?.rateLimits);
  if (!r || !main) return failed('error', accPlan);
  const plan = label(main.planType) ?? accPlan;
  const windows = codexWindows(main);
  // Separate limits (another model's own pool), each under its name.
  const mainId = main.limitId;
  const byId = obj(r.rateLimitsByLimitId);
  for (const [id, snap] of Object.entries(byId ?? {})) {
    if (id === mainId) continue;
    const name = label(obj(snap)?.limitName) ?? label(id);
    if (name) windows.push(...codexWindows(snap, name));
  }
  const credits = obj(r.rateLimitResetCredits);
  const resets = finite(credits?.availableCount);
  return { status: 'ok', ...(plan ? { plan } : {}), windows, ...(resets !== null && resets > 0 ? { resets: Math.floor(resets) } : {}) };
}

export const CODEX_ARGS = ['-c', 'approval_policy=never', '-c', 'features.plugins=false', 'app-server'];

// ---- Running the CLIs --------------------------------------------------------------------------

/** One line of JSON at a time from a child's stdout, up to MAX_OUTPUT in all. */
function lines(onLine: (msg: unknown) => void) {
  let buf = '';
  let seen = 0;
  return (chunk: string) => {
    seen += chunk.length;
    if (seen > MAX_OUTPUT) return;
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        onLine(JSON.parse(line));
      } catch {
        // Not a protocol line.
      }
    }
  };
}

/**
 * Starts `bin args` without a shell in a neutral folder, talks to it through `talk` and settles with
 * its result, or with `error` after the timeout. The child's stderr is dropped.
 */
function converse(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, talk: (send: (line: string) => void, done: (r: Reading) => void) => (msg: unknown) => void): Promise<Reading> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(bin, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (r: Reading) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
      // A closed stdin ends both; a stuck one is killed.
      child.stdin.end();
      const kill = setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 5_000);
      kill.unref();
    };
    const timer = setTimeout(() => finish(failed('error')), timeoutMs);
    const send = (line: string) => {
      if (!settled && child.stdin.writable) child.stdin.write(line);
    };
    const onMsg = talk(send, finish);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', lines(onMsg));
    child.on('error', (e: NodeJS.ErrnoException) => finish(failed(e.code === 'ENOENT' ? 'missing' : 'error')));
    child.on('close', () => finish(failed('error')));
    child.stdin.on('error', () => {});
  });
}

export type Probe = () => Promise<Reading>;

export function claudeProbe(bin: string, env = probeEnv(), timeoutMs = TIMEOUT_MS): Probe {
  return () =>
    converse(bin, CLAUDE_ARGS, env, timeoutMs, (send, done) => {
      send(CLAUDE_REQUEST);
      return (msg) => {
        const m = obj(msg);
        const res = m?.type === 'control_response' ? obj(m.response) : null;
        if (res?.request_id !== 'usage') return;
        done(res.subtype === 'success' ? parseClaudeUsage(res.response) : failed('error'));
      };
    });
}

export function codexProbe(bin: string, env = probeEnv(), timeoutMs = TIMEOUT_MS): Probe {
  return () =>
    converse(bin, CODEX_ARGS, env, timeoutMs, (send, done) => {
      const rpc = (id: number, method: string, params: unknown = {}) => send(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      let account: unknown = null;
      rpc(1, 'initialize', { clientInfo: { name: 'orca-office', version: '0.0.0' } });
      return (msg) => {
        const m = obj(msg);
        // Only answers to our requests: notifications and the server's own requests carry a method.
        if (!m || typeof m.id !== 'number' || 'method' in m) return;
        if (m.error) return done(m.id === 3 ? parseCodexUsage(account, null) : failed('error'));
        if (m.id === 1) {
          send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }) + '\n');
          rpc(2, 'account/read');
        } else if (m.id === 2) {
          account = m.result;
          const r = parseCodexUsage(account, null);
          // Not signed in, or an API key: nothing more to ask.
          if (r.status === 'signed-out' || r.status === 'no-plan') return done(r);
          rpc(3, 'account/rateLimits/read');
        } else if (m.id === 3) done(parseCodexUsage(account, m.result));
      };
    });
}

/**
 * Where a CLI is: `ORCA_OFFICE_<NAME>` when set, else the first executable of that name on PATH or
 * where installers put them (launchd's PATH is short), else null.
 */
export function findCli(name: string, env: NodeJS.ProcessEnv = process.env, extra = [path.join(os.homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']): string | null {
  const set = env[`ORCA_OFFICE_${name.toUpperCase()}`];
  if (set) return path.resolve(set);
  for (const dir of [...(env.PATH ?? '').split(path.delimiter), ...extra]) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // Not here.
    }
  }
  return null;
}

// ---- Polling -----------------------------------------------------------------------------------

export interface LimitsDeps {
  probes: Partial<Record<LimitsProviderId, Probe | null>>;
  /** Whether anyone is in the office to see the numbers; polls are skipped when not. */
  wanted: () => boolean;
  changed: (limits: PlanLimits) => void;
  now?: () => number;
  /** A read failed: the provider and the kind only. */
  error?: (what: string) => void;
}

interface Slot {
  id: LimitsProviderId;
  probe: Probe | null;
  state: ProviderLimits;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
  lastRead: number;
  fails: number;
}

/** Reads each provider's limits every POLL_MS while the office is open, each on its own clock. */
export class LimitsReader {
  private slots: Slot[];
  private closed = false;
  private now: () => number;

  constructor(private deps: LimitsDeps) {
    this.now = deps.now ?? Date.now;
    this.slots = (Object.keys(NAMES) as LimitsProviderId[]).map((id) => {
      const probe = deps.probes[id] ?? null;
      return { id, probe, running: false, lastRead: 0, fails: 0, state: { id, name: NAMES[id], status: probe ? 'loading' : 'missing', windows: [], at: 0 } };
    });
  }

  get state(): PlanLimits {
    const providers = this.slots.map((s) => s.state);
    return { providers, at: Math.max(0, ...providers.map((p) => p.at)) };
  }

  start(): void {
    for (const s of this.slots) this.schedule(s, 0);
  }

  /** Reads now (a click on the meter, someone walking in), unless a read runs or one just finished. */
  refresh(): void {
    for (const s of this.slots) if (!s.running && this.now() - s.lastRead >= MIN_GAP_MS) this.schedule(s, 0);
  }

  close(): void {
    this.closed = true;
    for (const s of this.slots) clearTimeout(s.timer);
  }

  private schedule(s: Slot, ms: number) {
    if (this.closed || !s.probe) return;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => void this.read(s), ms);
    s.timer.unref?.();
  }

  private async read(s: Slot) {
    if (!this.deps.wanted()) return this.schedule(s, POLL_MS);
    s.running = true;
    let r: Reading;
    try {
      r = await s.probe!();
    } catch {
      r = failed('error');
    }
    s.running = false;
    s.lastRead = this.now();
    if (this.closed) return;
    let next = POLL_MS;
    if (r.status === 'error') {
      this.deps.error?.(`usage limits: ${s.id} read failed`);
      if (++s.fails >= FAILS_BEFORE_BACKOFF) {
        s.fails = 0;
        next = BACKOFF_MS;
      }
      // A failed read keeps the last numbers it had, marked as failed only when there were none.
      if (s.state.status === 'ok') return this.schedule(s, next);
    } else {
      s.fails = 0;
      if (r.status !== 'ok') next = IDLE_MS;
    }
    const before = JSON.stringify({ ...s.state, at: 0 });
    s.state = { id: s.id, name: NAMES[s.id], ...r, at: this.now() };
    if (JSON.stringify({ ...s.state, at: 0 }) !== before || r.status === 'ok') this.deps.changed(this.state);
    this.schedule(s, next);
  }
}
