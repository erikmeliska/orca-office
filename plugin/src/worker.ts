import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OrcaWorkerApi } from 'orca/worker';

// M0 spike: forwards Orca workspace/agent state to the local orca-office bridge.
// Self-contained on purpose: Orca loads plugin files as is and refuses imports
// outside the plugin folder, so nothing here comes from ../shared.

const BRIDGE_URL = 'ws://127.0.0.1:4317/plugin';
const PROTOCOL = 0;
const RESYNC_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

/** Written by the bridge (0600); proves to the bridge that this is the plugin. */
const TOKEN_PATH = join(homedir(), '.orca-office', 'token');

/**
 * Host methods the bridge may call through this worker (design #14, #19).
 * Only after the token handshake; nothing that creates terminals or launches.
 */
const ALLOWED_CALLS = new Set(['workspace.list', 'agents.list', 'terminal.list', 'terminal.read', 'terminal.sendText']);

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
  let backoff = 1_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let resyncTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const status = (text: string, tone: 'neutral' | 'success' | 'warning' | 'danger', tooltip: string) =>
    orca.host.call('statusBar.update', { id: 'office', text, tone, tooltip }).catch(() => {});

  const send = (msg: Record<string, unknown>) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
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
    status('Office…', 'neutral', `Connecting to ${BRIDGE_URL}`);
    const token = readToken();
    if (!token) {
      status('Office ✕', 'warning', `No token at ${TOKEN_PATH}; start the bridge first`);
      scheduleReconnect();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${BRIDGE_URL}?token=${encodeURIComponent(token)}`);
    } catch (err) {
      orca.log(`connect threw: ${String(err)}`);
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.addEventListener('open', () => {
      backoff = 1_000;
      status('Office', 'success', `Connected to ${BRIDGE_URL}`);
      send({
        type: 'hello',
        role: 'plugin',
        protocol: PROTOCOL,
        runtime: { node: process.version, platform: process.platform, api: orca.api, caps: orca.grantedCapabilities },
      });
      snapshot().catch((err) => orca.log(`snapshot failed: ${errorCode(err)}`));
      resyncTimer = setInterval(() => snapshot().catch((err) => orca.log(`resync failed: ${errorCode(err)}`)), RESYNC_MS);
    });
    ws.addEventListener('message', (ev) => {
      handleMessage(String(ev.data)).catch((err) => orca.log(`message failed: ${errorCode(err)}`));
    });
    ws.addEventListener('close', () => {
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

  async function handleMessage(raw: string) {
    const msg = JSON.parse(raw) as { type?: string; id?: string; method?: string; params?: Json };
    if (msg.type === 'resync') return snapshot();
    if (msg.type !== 'call' || typeof msg.id !== 'string' || typeof msg.method !== 'string') return;
    if (!ALLOWED_CALLS.has(msg.method) || !validParams(msg.method, msg.params)) {
      send({ type: 'result', id: msg.id, ok: false, error: 'not_allowed' });
      return;
    }
    try {
      // The allowlist above bounds the methods; params are checked by Orca.
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
  // private content, so only the tool name and input keys leave the worker.
  orca.hooks.on('agent.tool.after', (event) => {
    const input = event.input;
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

/** Shape checks before anything reaches a terminal; Orca validates the rest. */
function validParams(method: string, params: Json | undefined): boolean {
  if (method !== 'terminal.sendText') return true;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const { terminalId, text, enter } = params as Record<string, Json>;
  return (
    typeof terminalId === 'string' &&
    terminalId.startsWith('term_') &&
    typeof text === 'string' &&
    text.length <= 4096 &&
    (enter === undefined || typeof enter === 'boolean')
  );
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.message : String(err);
}
