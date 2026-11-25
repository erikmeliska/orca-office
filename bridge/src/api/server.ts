/**
 * The Office API over HTTP (docs/api.md): `/api/v1/health`, `/api/v1/snapshot` and `/api/v1/events`
 * (Server-Sent Events), on the bridge's own port, read-only.
 *
 * For local processes, not browsers (design #20):
 * - Host must be the bridge's loopback address (DNS rebinding): else 421.
 * - Any request with an `Origin` header is refused (403): browsers send one on cross-origin requests
 *   and on every fetch from a page, a local process doesn't need one.
 * - Snapshot and events need `Authorization: Bearer <token>` with the consumer token in
 *   `~/.orca-office/api-token` (0600 in a 0700 folder; its own, apart from the plugin's HMAC key and
 *   the page's token), compared in constant time: else 401. Health needs none and says nothing private.
 * - Rate limits: failed tokens (a burst of 10, then one a second) and requests (a burst of 60, then 10
 *   a second): 429. At most MAX_STREAMS event streams at a time: 503.
 *
 * Responses are never logged; errors carry a code only.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { API_BASE, API_VERSION, type ApiChanged, type ApiHealth, type ApiHeartbeat, type ApiSnapshot } from '@orca-office/shared/office/api';
import { hostAllowed, tokenMatches } from '../auth.js';
import { Bucket } from '../rate.js';

export const DEFAULT_API_TOKEN_PATH = join(homedir(), '.orca-office', 'api-token');
export const HEARTBEAT_MS = 15_000;
/** `changed` events at most this often: a working agent's hooks would otherwise send one per 100 ms. */
export const CHANGED_MIN_GAP_MS = 1_000;
export const MAX_STREAMS = 8;

function readToken(path: string): string | null {
  try {
    const t = readFileSync(path, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** The consumer token, made on first use (as client-auth.ts makes the page's). */
export function loadOrCreateApiToken(path = DEFAULT_API_TOKEN_PATH): string {
  const found = readToken(path);
  if (found) {
    chmodSync(path, 0o600);
    return found;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const token = randomBytes(32).toString('hex');
  try {
    writeFileSync(path, token + '\n', { mode: 0o600, flag: 'wx' });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const theirs = readToken(path);
    if (theirs) return theirs;
    writeFileSync(path, token + '\n', { mode: 0o600 });
    chmodSync(path, 0o600);
    return token;
  }
}

export interface ApiDeps {
  port: number;
  /** The token as it is now (read once at start; a test passes its own). */
  token: () => string;
  /** A snapshot of now. */
  snapshot: () => ApiSnapshot;
  connected: () => boolean;
  now?: () => number;
}

type Verdict = { ok: true } | { ok: false; code: number; error: string };

export class OfficeApi {
  private streams = new Set<ServerResponse>();
  private requests: Bucket;
  private failures: Bucket;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private changedTimer: ReturnType<typeof setTimeout> | null = null;
  private lastChangedAt = 0;
  private sentRev = -1;
  private readonly now: () => number;

  constructor(private deps: ApiDeps) {
    this.now = deps.now ?? Date.now;
    this.requests = new Bucket(60, 10, this.now());
    this.failures = new Bucket(10, 1, this.now());
  }

  /** Whether this request is the API's (the caller hands everything else on). */
  static handles(url: string | undefined): boolean {
    const path = (url ?? '').split('?')[0] ?? '';
    return path === API_BASE || path.startsWith(`${API_BASE}/`);
  }

  /** Event streams open now (the office polls ports and limits while one is). */
  get listeners(): number {
    return this.streams.size;
  }

  /** Host, Origin and (unless `open`) the token, and the rate limits. */
  check(req: IncomingMessage, open = false): Verdict {
    if (!hostAllowed(req.headers.host, this.deps.port)) return { ok: false, code: 421, error: 'host' };
    if (req.headers.origin !== undefined) return { ok: false, code: 403, error: 'origin' };
    const now = this.now();
    if (!this.requests.take(1, now)) return { ok: false, code: 429, error: 'rate' };
    if (open) return { ok: true };
    const auth = req.headers.authorization;
    const given = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    if (tokenMatches(this.deps.token(), given)) return { ok: true };
    if (!this.failures.take(1, now)) return { ok: false, code: 429, error: 'rate' };
    return { ok: false, code: 401, error: 'unauthorized' };
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0] ?? '';
    const route = path.slice(API_BASE.length) || '/';
    const known = route === '/health' || route === '/snapshot' || route === '/events';
    const verdict = this.check(req, route === '/health' || !known);
    if (!verdict.ok) return this.fail(res, verdict.code, verdict.error, verdict.code === 401 ? { 'WWW-Authenticate': 'Bearer realm="orca-office"' } : {});
    if (!known) return this.fail(res, 404, 'not_found');
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.fail(res, 405, 'method', { Allow: 'GET, HEAD' });
    if (route === '/health') {
      const body: ApiHealth = { ok: true, version: API_VERSION, orca: { connected: this.deps.connected() } };
      return this.json(res, req.method === 'HEAD', body);
    }
    if (route === '/snapshot') return this.json(res, req.method === 'HEAD', this.deps.snapshot());
    this.stream(req, res);
  }

  /** Something may have changed: open streams hear `changed` if the content did, at most every CHANGED_MIN_GAP_MS. */
  changed(): void {
    if (!this.streams.size || this.changedTimer) return;
    const wait = Math.max(0, this.lastChangedAt + CHANGED_MIN_GAP_MS - this.now());
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null;
      this.flush();
    }, wait);
  }

  /** Closes every stream and stops the timers. */
  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.changedTimer) clearTimeout(this.changedTimer);
    this.heartbeat = this.changedTimer = null;
    for (const s of this.streams) s.end();
    this.streams.clear();
  }

  private flush(): void {
    if (!this.streams.size) return;
    const snap = this.deps.snapshot();
    this.lastChangedAt = this.now();
    if (snap.rev === this.sentRev) return;
    this.sentRev = snap.rev;
    const ev: ApiChanged = { rev: snap.rev, fingerprint: snap.fingerprint, at: snap.at };
    this.broadcast('changed', ev, snap.rev);
  }

  private stream(req: IncomingMessage, res: ServerResponse): void {
    if (this.streams.size >= MAX_STREAMS) return this.fail(res, 503, 'busy');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return void res.end();
    res.socket?.setNoDelay(true);
    const snap = this.deps.snapshot();
    this.sentRev = Math.max(this.sentRev, snap.rev);
    res.write(`retry: 3000\n\n`);
    res.write(event('snapshot', snap, snap.rev));
    this.streams.add(res);
    const drop = () => {
      this.streams.delete(res);
      if (!this.streams.size && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    };
    req.on('close', drop);
    res.on('error', drop);
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        // Stuck agents turn stuck with time alone: look at the content too.
        this.flush();
        const hb: ApiHeartbeat = { rev: this.sentRev, at: this.now() };
        this.broadcast('heartbeat', hb);
      }, HEARTBEAT_MS);
      this.heartbeat.unref?.();
    }
  }

  private broadcast(name: string, data: unknown, id?: number): void {
    const out = event(name, data, id);
    for (const s of this.streams) s.write(out);
  }

  private json(res: ServerResponse, head: boolean, value: unknown): void {
    const body = JSON.stringify(value);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(body) });
    res.end(head ? undefined : body);
  }

  private fail(res: ServerResponse, code: number, error: string, headers: Record<string, string> = {}): void {
    const body = JSON.stringify({ error });
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }
}

/** One SSE event: JSON on a single `data:` line (JSON.stringify never puts a newline in it). */
export function event(name: string, data: unknown, id?: number): string {
  return `event: ${name}\n${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
}
