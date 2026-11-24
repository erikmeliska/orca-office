import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OrcaWorkerApi } from 'orca/worker';

// Forwards Orca workspace/agent state to the local orca-office bridge, and carries out the
// office's light control (M3) through an allowlist of host calls.
// Self-contained on purpose: Orca loads plugin files as is and refuses imports
// outside the plugin folder, so nothing here comes from ../shared.

/**
 * The bridge's port: 4317, or what `~/.orca-office/port` says (one number), for a second bridge
 * next to the usual one while developing.
 */
function bridgeUrl(): string {
  let port = 4317;
  try {
    const n = Number(readFileSync(join(homedir(), '.orca-office', 'port'), 'utf8').trim());
    if (Number.isInteger(n) && n > 0 && n < 65536) port = n;
  } catch {
    // No override.
  }
  return `ws://127.0.0.1:${port}/plugin`;
}
const PROTOCOL = 0;
const RESYNC_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Written by the bridge (0600). Never sent over the socket: both sides prove
 * they know it with HMACs over each other's nonces (bridge/src/auth.ts), and
 * nothing is sent or obeyed before the bridge has proved itself.
 */
const TOKEN_PATH = join(homedir(), '.orca-office', 'token');

/**
 * Host methods the bridge may call through this worker (design #14, #19), each with the exact
 * shape of params it may pass (validParams below); only after the handshake. Light control (M3):
 * read and type into a terminal, show a workspace or a terminal in Orca, create a workspace with an
 * agent. Nothing that deletes, closes, merges or runs a bare command.
 */
export const ALLOWED_CALLS = new Set([
  'workspace.list',
  'agents.list',
  'terminal.list',
  'terminal.read',
  'terminal.sendText',
  'terminal.focus',
  'workspace.open',
  'workspace.create',
]);

/** Agents the office may start in a new workspace (bridge/src/live/actions.ts offers the same). */
export const LAUNCH_AGENTS = new Set(['claude', 'codex', 'gemini', 'opencode', 'copilot', 'cursor', 'pi']);
export const MAX_SEND_CHARS = 4096;
export const MAX_PROMPT_CHARS = 8000;

function readToken(): string | null {
  try {
    const t = readFileSync(TOKEN_PATH, 'utf8').trim();
    return t.length >= 32 ? t : null;
  } catch {
    return null;
  }
}


type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export default function activate(orca: OrcaWorkerApi) {
  let socket: WebSocket | null = null;
  let verified = false;
  let token: string | null = null;
  let workerNonce = '';
  let backoff = 1_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let resyncTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let url = bridgeUrl();

  const status = (text: string, tone: 'neutral' | 'success' | 'warning' | 'danger', tooltip: string) =>
    orca.host.call('statusBar.update', { id: 'office', text, tone, tooltip }).catch(() => {});

  const rawSend = (msg: Record<string, unknown>) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  };
  const send = (msg: Record<string, unknown>) => {
    if (verified) rawSend(msg);
  };

  async function snapshot() {
    const started = Date.now();
    const { workspaces, truncated } = await orca.host.call('workspace.list', { includeStatus: true });
    const agents: Record<string, unknown> = {};
    for (const ws of workspaces) {
      // Chat agents (Orca chats, bots) have no terminal, so terminalCount is 0
      // while they work: ask for every workspace that is not inactive.
      if (!ws.status || ws.status.state === 'inactive') continue;
      try {
        agents[ws.id] = (await orca.host.call('agents.list', { workspaceId: ws.id })).agents;
      } catch (err) {
        agents[ws.id] = { error: errorCode(err) };
      }
    }
    send({ type: 'snapshot', at: Date.now(), tookMs: Date.now() - started, truncated, workspaces, agents });
  }

  function connect() {
    if (stopped) return;
    url = bridgeUrl();
    status('Office…', 'neutral', `Connecting to ${url}`);
    token = readToken();
    verified = false;
    if (!token) {
      status('Office ✕', 'warning', `No token at ${TOKEN_PATH}; start the bridge first`);
      scheduleReconnect();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      orca.log(`connect threw: ${String(err)}`);
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.addEventListener('open', () => {
      workerNonce = randomBytes(16).toString('hex');
      rawSend({ type: 'challenge', nonce: workerNonce });
      setTimeout(() => {
        if (socket === ws && !verified) ws.close(4001, 'auth timeout');
      }, 5_000);
    });
    ws.addEventListener('message', (ev) => {
      handleMessage(String(ev.data)).catch((err) => orca.log(`message failed: ${errorCode(err)}`));
    });
    ws.addEventListener('close', () => {
      verified = false;
      if (resyncTimer) clearInterval(resyncTimer);
      resyncTimer = null;
      if (socket === ws) socket = null;
      status('Office ✕', 'warning', 'Bridge offline; retrying');
      scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // 'close' follows; nothing to do here.
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  function onVerified() {
    verified = true;
    backoff = 1_000;
    status('Office', 'success', `Connected to ${url}`);
    send({
      type: 'hello',
      role: 'plugin',
      protocol: PROTOCOL,
      runtime: { node: process.version, platform: process.platform, api: orca.api, caps: orca.grantedCapabilities },
    });
    snapshot().catch((err) => orca.log(`snapshot failed: ${errorCode(err)}`));
    resyncTimer = setInterval(() => snapshot().catch((err) => orca.log(`resync failed: ${errorCode(err)}`)), RESYNC_MS);
  }

  async function handleMessage(raw: string) {
    const msg = JSON.parse(raw) as { type?: string; id?: string; method?: string; params?: Json; nonce?: unknown; proof?: unknown };
    if (!verified) {
      // Only the bridge's answer to our challenge is accepted before verification.
      const ok =
        msg.type === 'auth' &&
        token !== null &&
        typeof msg.nonce === 'string' &&
        /^[0-9a-f]{32}$/.test(msg.nonce) &&
        typeof msg.proof === 'string' &&
        safeEqual(hmac(token, 'bridge', workerNonce, msg.nonce), msg.proof);
      if (!ok) {
        orca.log('bridge failed authentication; closing');
        socket?.close(4001, 'auth failed');
        return;
      }
      rawSend({ type: 'auth', proof: hmac(token!, 'plugin', msg.nonce as string, workerNonce) });
      onVerified();
      return;
    }
    if (msg.type === 'resync') return snapshot();
    if (msg.type !== 'call' || typeof msg.id !== 'string' || typeof msg.method !== 'string') return;
    if (!ALLOWED_CALLS.has(msg.method) || !validParams(msg.method, msg.params)) {
      send({ type: 'result', id: msg.id, ok: false, error: 'not_allowed' });
      return;
    }
    try {
      // The allowlist and validParams bound the methods and their params; Orca checks the rest.
      const call = orca.host.call as (m: string, p?: unknown) => Promise<unknown>;
      const value = await call(msg.method, msg.params ?? undefined);
      send({ type: 'result', id: msg.id, ok: true, value });
    } catch (err) {
      send({ type: 'result', id: msg.id, ok: false, error: errorCode(err), message: (err as Error).message });
    }
  }

  for (const name of ['agent.status.changed', 'workspace.created', 'workspace.removed', 'workspace.changed'] as const) {
    orca.events.on(name, (payload) => send({ type: 'event', name, at: Date.now(), payload }));
  }

  // Observe-only hook: Orca does not wait for it. Tool input/output can hold
  // private content, so only the tool name, input keys and what the call looks
  // like from across the room (read/edit/test/web, and whether a test run
  // failed) leave the worker; never a command, a path or any output.
  orca.hooks.on('agent.tool.after', (event) => {
    const input = event.input;
    const action = toolAction(event.tool, input);
    send({
      type: 'hook',
      name: 'agent.tool.after',
      at: Date.now(),
      payload: {
        agent: event.agent,
        workspaceId: event.workspaceId,
        terminalId: event.terminalId ?? null,
        tool: event.tool,
        callId: event.callId ?? null,
        inputKeys: input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : [],
        hasOutput: event.output !== undefined,
        action: action ?? null,
        failed: action === 'test' && outputFailed(event.output),
      },
    });
  });

  orca.commands.register('office.reconnect', () => {
    socket?.close();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    backoff = 1_000;
    connect();
    return 'Reconnecting to the orca-office bridge';
  });

  connect();

  return {
    dispose() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (resyncTimer) clearInterval(resyncTimer);
      socket?.close();
    },
  };
}

/**
 * Shape checks before a call reaches Orca: only the keys each method may take, each of the right
 * type and size; Orca validates the rest. Anything else is refused as `not_allowed`.
 */
export function validParams(method: string, params: Json | undefined): boolean {
  const p = params === undefined || params === null ? {} : params;
  if (typeof p !== 'object' || Array.isArray(p)) return false;
  const o = p as Record<string, Json>;
  const only = (...keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
  const id = (v: Json | undefined, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max;
  const term = (v: Json | undefined) => typeof v === 'string' && /^term_[A-Za-z0-9_-]{1,120}$/.test(v);
  switch (method) {
    case 'workspace.list':
      return only('includeStatus') && (o.includeStatus === undefined || typeof o.includeStatus === 'boolean');
    case 'agents.list':
    case 'terminal.list':
      return only('workspaceId') && (o.workspaceId === undefined || id(o.workspaceId));
    case 'terminal.read':
      return only('terminalId', 'maxLines') && term(o.terminalId) && (o.maxLines === undefined || (Number.isInteger(o.maxLines) && (o.maxLines as number) >= 1 && (o.maxLines as number) <= 2000));
    case 'terminal.sendText':
      return only('terminalId', 'text', 'enter') && term(o.terminalId) && typeof o.text === 'string' && o.text.length <= MAX_SEND_CHARS && (o.enter === undefined || typeof o.enter === 'boolean');
    case 'terminal.focus':
      return only('terminalId') && term(o.terminalId);
    case 'workspace.open':
      return only('workspaceId') && id(o.workspaceId);
    case 'workspace.create':
      return (
        only('projectId', 'hostId', 'name', 'agent', 'prompt') &&
        id(o.projectId) &&
        (o.hostId === undefined || id(o.hostId, 200)) &&
        (o.name === undefined || (typeof o.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(o.name))) &&
        typeof o.agent === 'string' &&
        LAUNCH_AGENTS.has(o.agent) &&
        typeof o.prompt === 'string' &&
        o.prompt.trim().length > 0 &&
        o.prompt.length <= MAX_PROMPT_CHARS
      );
    default:
      return false;
  }
}

/** Same computation as `proof()` in bridge/src/auth.ts. */
function hmac(token: string, role: 'bridge' | 'plugin', first: string, second: string): string {
  return createHmac('sha256', token).update(`orca-office|${role}|${first}|${second}`).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.message : String(err);
}

// ---- What a tool call looks like (a copy of shared/src/office/actions.ts) ----------------------
// Orca loads plugin files as they are and refuses imports outside this folder, so the office's
// tool → action rules are copied here; plugin/actions.test.ts checks the copy matches.

type Action = 'read' | 'edit' | 'test' | 'web';

const READ_TOOLS = new Set(['read', 'read_file', 'view', 'view_file', 'grep', 'grep_files', 'glob', 'ls', 'list', 'list_dir', 'list_files', 'find', 'codesearch', 'search_files', 'notebookread']);
const EDIT_TOOLS = new Set(['edit', 'multiedit', 'write', 'write_file', 'create_file', 'notebookedit', 'apply_patch', 'patch', 'str_replace', 'str_replace_editor', 'str_replace_based_edit_tool']);
const WEB_TOOLS = new Set(['websearch', 'webfetch', 'web_search', 'web_fetch', 'fetch', 'browse', 'search_web']);
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec_command', 'local_shell', 'run_command', 'terminal']);

export function toolAction(tool: unknown, input?: unknown): Action | undefined {
  if (typeof tool !== 'string') return undefined;
  const name = tool.toLowerCase().replace(/^.*[.:/]/, '');
  if (READ_TOOLS.has(name)) return 'read';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (WEB_TOOLS.has(name)) return 'web';
  if (/^mcp__/.test(name)) return /web|fetch|brows|url|http/.test(name) ? 'web' : undefined;
  if (SHELL_TOOLS.has(name)) {
    const command = (input as { command?: unknown } | undefined)?.command;
    return typeof command === 'string' ? commandAction(command) : undefined;
  }
  return undefined;
}

const CHECK =
  /^(?:tsc|vue-tsc|svelte-check|jest|vitest|mocha|ava|pytest|py\.test|tox|nox|rspec|phpunit|karma|mypy|pyright|eslint|make|cmake|ninja|gradlew?|mvnw?|xcodebuild|ctest|bazel|bazelisk|webpack|rollup|turbo|nx|sbt)$|^(?:go (?:test|build|vet)|cargo (?:test|build|check|clippy|nextest)|dotnet (?:test|build)|swift (?:test|build)|mix (?:test|compile)|zig (?:build|test)|deno (?:test|check)|bun test|(?:flutter|dart) test|playwright test|cypress run|ruff check|(?:next|vite|nuxt|astro|ng) build|rake (?:test|spec))\b/;
const CHECK_SCRIPT = /^(?:t|test|tests|build|check|lint|typecheck|type-check|tsc|compile|e2e|spec|verify|ci)(?:[:-]\S*)?$/;
const READ = /^(?:cat|bat|head|tail|less|more|grep|egrep|fgrep|rg|ag|ack|find|fd|ls|tree|wc|stat|file|du|jq|diff|nl|awk)$/;
const READ_SUB = /^sed -n\b|^git(?: (?:-C \S+|--?[\w-]+(?:=\S+)?))* (?:log|show|diff|status|blame|grep|ls-files|shortlog)\b|^gh (?:issue|pr|repo|run) (?:view|list|diff)\b/;
const PREFIX = /^(?:\w+=(?:'[^']*'|"[^"]*"|\S*)\s+|(?:sudo|time|nice|nohup|command|exec|env|npx|bunx|pnpx|caffeinate|xvfb-run)\s+|(?:bundle exec|poetry run|uv run|pipenv run|pdm run|pnpm exec|yarn exec|python3? -m)\s+|timeout\s+\S+\s+)/;

export function commandAction(command: string): 'test' | 'read' | undefined {
  let first: 'read' | undefined;
  let leading = true;
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const words = normalize(part);
    if (!words.length) continue;
    if (isCheck(words)) return 'test';
    if (!leading || /^(?:cd|pushd|export|source|set|\.)$/.test(words[0]!)) continue;
    leading = false;
    if (READ.test(words[0]!) || READ_SUB.test(words.join(' '))) first = 'read';
  }
  return first;
}

function normalize(part: string): string[] {
  let s = part.replace(/^[\s({]+/, '').trim();
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(PREFIX, '');
  }
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length) words[0] = words[0]!.replace(/^.*[/\\]/, '').replace(/\.(?:cmd|exe|bat)$/i, '');
  return words;
}

function isCheck(words: string[]): boolean {
  const [prog, ...rest] = words as [string, ...string[]];
  if (CHECK.test(prog) || CHECK.test(`${prog} ${rest[0] ?? ''}`)) return true;
  if (/^(?:node|tsx|bun|deno)$/.test(prog) && rest.includes('--test')) return true;
  if (/^(?:npm|pnpm|yarn|bun)$/.test(prog)) {
    const script = rest.find((w) => !w.startsWith('-') && w !== 'run' && w !== 'run-script');
    return !!script && CHECK_SCRIPT.test(script);
  }
  return false;
}

const FAILED = [
  /^Tests:\s.*\b[1-9]\d* failed/m,
  /^\s*(?:Test Files|Tests)\s+[1-9]\d* failed/m,
  /^(?:#|ℹ) fail [1-9]/m,
  /^=+ .*\b[1-9]\d* (?:failed|errors?)\b/m,
  /^\s+[1-9]\d* failing$/m,
  /^[1-9]\d* examples?, [1-9]\d* failures?/m,
  /^(?:FAIL|--- FAIL)\b/m,
  /^test result: FAILED/m,
  /^error(?:\[E\d{4}\])?: /m,
  /\berror TS\d{4}:|^Found [1-9]\d* errors?\b/m,
  /^npm (?:ERR!|error) /m,
  /^make: \*\*\*|\bBUILD FAILED\b/m,
];

/** Whether a test or build run's output says it failed: its exit code when the hook has one, else the summary lines. */
export function outputFailed(output: unknown): boolean {
  const o = output as { exitCode?: unknown; exit_code?: unknown; stdout?: unknown; stderr?: unknown; output?: unknown } | null | undefined;
  const code = o && typeof o === 'object' ? (o.exitCode ?? o.exit_code) : undefined;
  if (typeof code === 'number') return code !== 0;
  const text = typeof output === 'string' ? output : o && typeof o === 'object' ? [o.stdout, o.stderr, o.output].filter((x) => typeof x === 'string').join('\n') : '';
  const tail = text.length > 8000 ? text.slice(-8000) : text;
  return FAILED.some((re) => re.test(tail));
}
