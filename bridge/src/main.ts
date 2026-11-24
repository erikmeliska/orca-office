import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, redactForLog } from '@orca-office/shared';
import { hostAllowed, isNonce, loadOrCreateToken, newNonce, proof, tokenMatches } from './auth.js';
import { loadConfig } from './config.js';
import { allowedClientOrigins, checkUpgrade } from './origin.js';
import { PluginLink } from './plugin-link.js';
import { StubSession } from './stub.js';
import { CliPoller, orcaCli } from './live/cli.js';
import { LiveModel } from './live/model.js';
import { parseStatusEvent, parseToolHook, parseWorkspaces } from './live/orca.js';
import { LiveSession } from './live/session.js';

const config = loadConfig();
const clientOrigins = allowedClientOrigins(config.clientPort);
const link = new PluginLink();
const token = loadOrCreateToken();
const spikeCalls = process.env.ORCA_OFFICE_SPIKE_CALLS === '1';
const clients = new Set<WebSocket>();
let lastPluginHello: unknown = null;
let lastSnapshotAt: number | null = null;
/** Redacted copy of the newest snapshot, sent to each client as it connects. */
let lastSnapshot: string | null = null;

// M0 spike: every plugin message is appended here, redacted, to study payload shapes.
const spikeLog = process.env.ORCA_OFFICE_SPIKE_LOG === '1'
  ? join(dirname(fileURLToPath(import.meta.url)), '..', '.spike', 'messages.jsonl')
  : null;
if (spikeLog) mkdirSync(dirname(spikeLog), { recursive: true });

function record(msg: unknown) {
  if (spikeLog) appendFileSync(spikeLog, JSON.stringify({ at: Date.now(), msg: redactForLog(msg) }) + '\n');
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) throw new Error('too_large');
  }
  return body;
}

const server = createServer(async (req, res) => {
  if (!hostAllowed(req.headers.host, config.port)) {
    res.writeHead(421).end();
    return;
  }
  const json = (code: number, value: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.method === 'GET' && req.url === '/health') {
    return json(200, { ok: true, protocol: PROTOCOL_VERSION, stub: config.stub, plugin: link.connected, lastSnapshotAt, hello: lastPluginHello });
  }
  // Spike-only: drive host calls from the shell. Off unless ORCA_OFFICE_SPIKE_CALLS=1,
  // needs the token as a bearer and is refused for browsers (any Origin).
  if (
    spikeCalls &&
    req.method === 'POST' &&
    req.url === '/spike/call' &&
    req.headers.origin === undefined &&
    tokenMatches(token, req.headers.authorization?.replace(/^Bearer /, ''))
  ) {
    try {
      const { method, params } = JSON.parse(await readBody(req)) as { method: string; params?: unknown };
      return json(200, await link.call(method, params));
    } catch (err) {
      return json(400, { ok: false, error: String(err) });
    }
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const peer = hostAllowed(req.headers.host, config.port) ? checkUpgrade(req.url, req.headers.origin, clientOrigins) : null;
  if (!peer) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => (peer === 'plugin' ? onPlugin(ws) : onClient(ws, req.url)));
});

function onPlugin(ws: WebSocket) {
  // Nothing from this socket counts until it passes the handshake (auth.ts).
  let verified = false;
  let workerNonce: string | null = null;
  let bridgeNonce: string | null = null;
  const authTimer = setTimeout(() => {
    if (!verified) ws.close(4001, 'auth timeout');
  }, 5_000);

  ws.on('message', (data) => {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!verified) {
      if (msg.type === 'challenge' && bridgeNonce === null && isNonce(msg.nonce)) {
        workerNonce = msg.nonce;
        bridgeNonce = newNonce();
        ws.send(JSON.stringify({ type: 'auth', nonce: bridgeNonce, proof: proof(token, 'bridge', msg.nonce, bridgeNonce) }));
        return;
      }
      if (msg.type === 'auth' && bridgeNonce !== null && typeof msg.proof === 'string') {
        return void verifyPlugin(msg.proof);
      }
      ws.close(4001, 'auth failed');
      return;
    }
    record(msg);
    if (msg.type === 'hello') lastPluginHello = msg;
    if (msg.type === 'snapshot') lastSnapshotAt = Date.now();
    if (msg.type === 'result') return void link.settle(msg as never);
    if (!config.stub) feedModel(msg);
    const out = JSON.stringify(redactForLog(msg));
    if (msg.type === 'snapshot') lastSnapshot = out;
    for (const c of clients) c.send(out);
  });

  function verifyPlugin(given: string) {
    if (workerNonce === null || bridgeNonce === null || !tokenMatches(proof(token, 'plugin', bridgeNonce, workerNonce), given)) {
      ws.close(4001, 'auth failed');
      return;
    }
    verified = true;
    clearTimeout(authTimer);
    link.attach(ws);
    broadcastPlugin();
    console.log('plugin connected (verified)');
  }

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (verified) {
      link.detach(ws);
      broadcastPlugin();
      console.log('plugin disconnected');
    }
  });
}

function broadcastPlugin() {
  const out = JSON.stringify({ type: 'bridge', plugin: link.connected });
  for (const c of clients) c.send(out);
  const orca = JSON.stringify({ t: 'orca', online: link.connected });
  for (const s of liveSessions.keys()) if (s.readyState === s.OPEN) s.send(orca);
}

// ---- Live office (M2): Orca's workspaces and agents on the 3D client's protocol -------------------

const model = new LiveModel();
const liveSessions = new Map<WebSocket, LiveSession>();
let sentVersion = -1;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const poller = new CliPoller(orcaCli(), {
  agents: (host, list) => (model.applyAgents(host, list.agents, Date.now()), changed()),
  bots: (bots) => (model.applyBots(bots), changed()),
  error: (what) => logOnce(what),
});

/** One line per kind of failure, not one every 5 s. */
const logged = new Set<string>();
function logOnce(what: string) {
  if (logged.has(what)) return;
  logged.add(what);
  console.warn(what);
}

/** Plugin messages the office uses: the snapshot's workspaces, status events and tool hooks. */
function feedModel(msg: { type?: string; name?: unknown; payload?: unknown; [k: string]: unknown }) {
  const now = Date.now();
  if (msg.type === 'snapshot') model.applyWorkspaces(parseWorkspaces(msg));
  else if (msg.type === 'event' && msg.name === 'agent.status.changed') {
    const ev = parseStatusEvent(msg.payload, now);
    if (ev && model.applyStatus(ev)) poller.kick();
  } else if (msg.type === 'event' && (msg.name === 'workspace.created' || msg.name === 'workspace.removed')) {
    // The next snapshot has it; ask for one now.
    link.send({ type: 'resync' });
  } else if (msg.type === 'hook' && msg.name === 'agent.tool.after') {
    const h = parseToolHook(msg.payload, now);
    if (h) model.applyHook(h);
  } else return;
  changed();
}

/** Something changed: every live page hears what changed on its floor, at most every 100 ms. */
function changed() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 100);
}

function flush() {
  flushTimer = null;
  if (model.version === sentVersion) return;
  sentVersion = model.version;
  const b = model.building();
  for (const [ws, s] of liveSessions) for (const m of s.update(b)) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
}

if (!config.stub) {
  poller.start();
  // The done debounce and fading actions run on the clock.
  setInterval(() => {
    const v = model.version;
    model.tick(Date.now());
    if (model.version !== v) changed();
  }, 250);
}

/** How often a stub session's working workers move on to their next action. */
const STUB_TICK_MS = 4_000;

function onClient(ws: WebSocket, url: string | undefined) {
  if (config.stub) return onStubClient(ws, url);
  const query = new URL(url ?? '/client', 'http://127.0.0.1').searchParams;
  // The 2D list view (live.html) still gets the plugin's messages as they are, redacted.
  if (query.get('list') !== '1') return onLiveClient(ws, query);
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', role: 'bridge', protocol: PROTOCOL_VERSION, plugin: link.connected }));
  if (lastSnapshot && link.connected) ws.send(lastSnapshot);
  ws.on('close', () => clients.delete(ws));
}

/** The 3D office on Orca's data (M2). */
function onLiveClient(ws: WebSocket, query: URLSearchParams) {
  const session = new LiveSession(randomUUID().slice(0, 10), query, model.building());
  liveSessions.set(ws, session);
  const send = (msgs: unknown[]) => {
    for (const m of msgs) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  send(session.welcome(model.building(), `live-${PROTOCOL_VERSION}`, link.connected));
  ws.on('message', (data) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof (msg as { t?: unknown }).t !== 'string') return;
    try {
      send(session.handle(msg as never, model.building()));
    } catch {
      // A malformed message from the page: ignored.
    }
  });
  ws.on('close', () => liveSessions.delete(ws));
}

/**
 * Stub mode (#12): the 3D office talks to made-up data (stub.ts), not to Orca. The plugin side is
 * unchanged; what it sends goes to no stub page.
 */
function onStubClient(ws: WebSocket, url: string | undefined) {
  const session = new StubSession(randomUUID().slice(0, 10), new URL(url ?? '/client', 'http://127.0.0.1').searchParams);
  const send = (msgs: unknown[]) => {
    for (const m of msgs) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  send([session.welcome()]);
  const timer = setInterval(() => send(session.tick()), STUB_TICK_MS);
  ws.on('message', (data) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof (msg as { t?: unknown }).t !== 'string') return;
    try {
      send(session.handle(msg as never));
    } catch {
      // A malformed message from the page: ignore it, as the stub ignores what it doesn't know.
    }
  });
  ws.on('close', () => clearInterval(timer));
}

server.listen(config.port, config.host, () => {
  console.log(`orca-office bridge on http://${config.host}:${config.port}${config.stub ? ' (stub: made-up office data on /client)' : ''}${spikeLog ? ` (spike log ${spikeLog})` : ''}${spikeCalls ? ' (spike calls on)' : ''}`);
});
