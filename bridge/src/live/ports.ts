/**
 * The dev servers running in Orca's worktrees (roadmap B7): `orca ports --all --json` every ~10 s
 * while a page is open. Real shape, checked on Orca 1.4.272:
 *
 *   result.ports[]: id, bindHost, connectHost, port, pid, processName, protocol ('http' | 'unknown'),
 *     kind ('workspace' | 'external'), advertisedUrl? (what the server printed in an Orca terminal),
 *     owner? { worktreeId (`<repoId>::<path>`), repoId, displayName, path, confidence ('cwd' | 'command') }
 *
 * Only `workspace` listeners are kept (an `external` one belongs to no worktree: Orca itself, the
 * agents' MCP sockets, system services); of those, only what looks like a server someone would open:
 * HTTP, a printed URL, or a port below the ephemeral range (agents' own sockets live up there).
 *
 * The command line comes from `ps` (Orca gives only the process name), shortened and with anything
 * that looks like a secret dropped (`--token=…`, `KEY=…`, long random strings). The page title comes
 * from a GET of the server's front page, cut short. Nothing here is logged or stored.
 */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { toBubble } from '@orca-office/shared';
import type { RunJson } from './cli.js';

export const PORTS_EVERY_MS = 10_000;
/** macOS and Linux hand out ports from here up to sockets nobody chose: an agent's MCP link, a debugger. */
export const EPHEMERAL_FROM = 49152;
const TITLE_EVERY_MS = 60_000;
const TITLE_TIMEOUT_MS = 1_500;
const COMMAND_MAX = 80;
export const TITLE_MAX = 60;

export interface OrcaPort {
  port: number;
  pid: number;
  /** The address the bridge reaches it on. */
  host: string;
  processName: string;
  http: boolean;
  /** What the server printed in an Orca terminal, when Orca saw it. */
  url: string | null;
  /** The worktree's path, as Orca tied the port to it. */
  path: string;
  worktree: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

/** A local http(s) address only: the page opens it in a new tab. */
function localUrl(v: unknown): string | null {
  const s = str(v);
  if (!s || s.length > 200) return null;
  try {
    const u = new URL(s);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
    return /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(u.hostname) ? `${u.protocol}//${u.host}${u.pathname}` : null;
  } catch {
    return null;
  }
}

/** The listeners worth a row on the services board, one per port (the first of a dual-stack pair). */
export function parsePorts(json: unknown, skip: ReadonlySet<number> = new Set()): OrcaPort[] {
  const rows = obj(obj(json)?.result)?.ports;
  if (!Array.isArray(rows)) return [];
  const out = new Map<number, OrcaPort>();
  for (const r of rows.map(obj)) {
    const port = num(r?.port);
    const owner = obj(r?.owner);
    const path = str(owner?.path);
    if (!r || !port || r.kind !== 'workspace' || !path || skip.has(port) || out.has(port)) continue;
    const http = r.protocol === 'http' || r.protocol === 'https';
    const url = localUrl(r.advertisedUrl);
    if (!http && !url && port >= EPHEMERAL_FROM) continue;
    const bind = str(r.connectHost) ?? '127.0.0.1';
    out.set(port, {
      port,
      pid: num(r.pid) ?? 0,
      host: bind === '*' || bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind,
      processName: (str(r.processName) ?? '').slice(0, 40),
      http,
      url,
      path,
      worktree: (str(owner?.displayName) ?? basename(path)).slice(0, 60),
    });
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

const SECRET_KEY = /(token|secret|passw(or)?d|pwd|key|auth|cred|cookie|session|bearer|signature|sig)/i;

/** An argument that is a secret by its looks alone: long and random, a JWT, a known token prefix. */
function looksSecret(a: string): boolean {
  if (/^(gh[pousr]_|glpat-|sk-|xox[abpr]-|AKIA|eyJ)/.test(a)) return true;
  if (a.length >= 24 && /^[A-Za-z0-9_\-+/=.]+$/.test(a) && /\d/.test(a) && /[A-Za-z]/.test(a) && !a.includes('/')) return true;
  return false;
}

/**
 * A command line as the board shows it: the program's name instead of its path, paths cut to their
 * last part, and every value that may be a secret replaced by `…` (`--token=…`, `API_KEY=…`, a value
 * after `--password`, anything that looks like a token). Cut to COMMAND_MAX characters.
 */
export function safeCommand(line: string): string {
  const args = line.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let hideNext = false;
  for (let i = 0; i < args.length; i++) {
    let a = args[i]!;
    if (hideNext) {
      out.push('…');
      hideNext = false;
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      const k = a.slice(0, eq);
      // An environment variable (KEY=value) or a flag with its value (--token=value).
      if (SECRET_KEY.test(k) || /^[A-Z_][A-Z0-9_]*$/.test(k) || looksSecret(a.slice(eq + 1))) {
        out.push(`${k}=…`);
        continue;
      }
    } else if (/^-{1,2}[A-Za-z]/.test(a) && SECRET_KEY.test(a)) {
      out.push(a);
      hideNext = true;
      continue;
    }
    if (looksSecret(a)) a = '…';
    else if (a.includes('/') && !/^https?:/.test(a)) a = (i === 0 ? basename(a) : a.split('/').filter(Boolean).pop()) ?? a;
    out.push(a);
  }
  return toBubble(out.join(' '), COMMAND_MAX) ?? '';
}

/** A page's <title>, unescaped and cut short. */
export function pageTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html);
  if (!m) return null;
  const t = m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return toBubble(t, TITLE_MAX);
}

/** `ps -o command= -p <pid>`, without a shell; null when the process is gone. */
export function psCommand(pid: number, bin = process.env.ORCA_OFFICE_PS || 'ps'): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['-o', 'command=', '-p', String(pid)], { timeout: 2_000, maxBuffer: 64 * 1024 }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
  });
}

/** The front page's title, read with a short timeout and at most 64 kB. */
export async function fetchTitle(host: string, port: number): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TITLE_TIMEOUT_MS);
  try {
    const h = host.includes(':') ? `[${host}]` : host;
    const res = await fetch(`http://${h}:${port}/`, { signal: ctl.signal, redirect: 'manual', headers: { accept: 'text/html' } });
    if (!(res.headers.get('content-type') ?? '').includes('html') || !res.body) return null;
    const reader = res.body.getReader();
    let html = '';
    while (html.length < 64 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      html += new TextDecoder().decode(value);
      if (/<\/title>/i.test(html)) break;
    }
    void reader.cancel().catch(() => {});
    return pageTitle(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A dev server as the model keeps it: the port with its command and title filled in. */
export interface PortRow extends OrcaPort {
  command: string;
  title: string | null;
  /** When the office first saw it. */
  since: number;
}

export interface PortsDeps {
  run: RunJson;
  command?: (pid: number) => Promise<string | null>;
  title?: (host: string, port: number) => Promise<string | null>;
  /** Ports the office itself listens on (the bridge, Vite): never listed. */
  skip?: ReadonlySet<number>;
  /** Only while a page is open. */
  wanted: () => boolean;
  changed: (rows: PortRow[]) => void;
  error: (what: string) => void;
  now?: () => number;
}

export class PortsPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private known = new Map<string, { command: string; title: string | null; titleAt: number; since: number }>();
  private sent = '';
  /** When the last read finished (0: never); the Office API says `loading` until a fresh one. */
  readAt = 0;

  constructor(private deps: PortsDeps, private everyMs = PORTS_EVERY_MS) {}

  /** Someone started looking (an Office API snapshot): read now, unless a read runs or one is fresh. */
  kick(): void {
    const now = (this.deps.now ?? Date.now)();
    if (this.running || now - this.readAt < this.everyMs) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.poll();
  }

  /** Whether the last read is recent enough to stand for now (polling pauses while nobody looks). */
  fresh(now = (this.deps.now ?? Date.now)()): boolean {
    return this.readAt > 0 && now - this.readAt <= 3 * this.everyMs;
  }

  start(): void {
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.deps.wanted()) await this.read();
    } catch (err) {
      this.deps.error((err as Error).message);
    }
    this.running = false;
    this.timer = setTimeout(() => void this.poll(), this.everyMs);
  }

  /** One read: the ports, each new process's command, and titles at most once a minute per server. */
  async read(): Promise<PortRow[]> {
    const now = (this.deps.now ?? Date.now)();
    const ports = parsePorts(await this.deps.run(['ports', '--all', '--json']), this.deps.skip);
    const rows: PortRow[] = [];
    const seen = new Set<string>();
    for (const p of ports) {
      const key = `${p.pid}:${p.port}`;
      seen.add(key);
      let k = this.known.get(key);
      if (!k) {
        const line = p.pid ? await (this.deps.command ?? psCommand)(p.pid) : null;
        k = { command: line ? safeCommand(line) : p.processName, title: null, titleAt: -Infinity, since: now };
        this.known.set(key, k);
      }
      if (p.http && now - k.titleAt >= TITLE_EVERY_MS) {
        k.titleAt = now;
        k.title = await (this.deps.title ?? fetchTitle)(p.host, p.port);
      }
      rows.push({ ...p, command: k.command || p.processName, title: k.title, since: k.since });
    }
    for (const key of this.known.keys()) if (!seen.has(key)) this.known.delete(key);
    this.readAt = (this.deps.now ?? Date.now)();
    const sent = JSON.stringify(rows);
    if (sent !== this.sent) {
      this.sent = sent;
      this.deps.changed(rows);
    }
    return rows;
  }
}
