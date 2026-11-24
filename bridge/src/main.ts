import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, redactForLog } from '@orca-office/shared';
import { hostAllowed, isNonce, loadOrCreateToken, newNonce, proof, tokenMatches } from './auth.js';
import { CLIENT_PROTOCOL, clientAuthorized, loadOrCreateClientToken, mayHaveToken } from './client-auth.js';
import { DEFAULT_DIST, PAGE_HEADERS, distReady, readStatic, resolveStatic } from './static.js';
import { loadConfig } from './config.js';
import { allowedClientOrigins, checkUpgrade } from './origin.js';
import { PluginLink } from './plugin-link.js';
import { StubSession } from './stub.js';
import { CliPoller, orcaBotSend, orcaCli, orcaSend } from './live/cli.js';
import { LiveModel } from './live/model.js';
import { parseStatusEvent, parseToolHook, parseWorkspaces } from './live/orca.js';
import { LiveSession } from './live/session.js';
import { RunsPoller } from './live/runs-poller.js';
import { Actions } from './live/actions.js';
import { BotChats } from './live/bots.js';
import { TerminalWatch } from './live/terminals.js';
import { ForgeBoards, ghAdapter, gitRemote, glabAdapter, runCli } from './live/forge.js';
import { pageLimits } from './rate.js';

const config = loadConfig();
// The page from Vite (developing) or from the bridge itself (the built page, static.ts).
const clientOrigins = allowedClientOrigins(config.clientPort, config.port);
const link = new PluginLink();
const token = loadOrCreateToken();
// The office page's token (client-auth.ts): made now if Vite hasn't yet, read again on each upgrade.
loadOrCreateClientToken();
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
  if (req.method === 'GET' || req.method === 'HEAD') {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
    // The page's token for the built page served from here, on the same terms as Vite's (client-auth.ts).
    if (path === '/__orca-office/token') {
      res.setHeader('Cache-Control', 'no-store');
      if (!mayHaveToken({ host: one(req.headers.host), origin: one(req.headers.origin), fetchSite: one(req.headers['sec-fetch-site']) }, config.port)) {
        res.writeHead(403).end();
        return;
      }
      return json(200, { token: loadOrCreateClientToken() });
    }
    const file = resolveStatic(DEFAULT_DIST, path);
    if (file) {
      res.writeHead(200, { ...PAGE_HEADERS, 'Content-Type': file.type, 'Cache-Control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : readStatic(file));
      return;
    }
    if (path === '/' && !distReady(DEFAULT_DIST)) {
      res.writeHead(503, { ...PAGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('The office page is not built: run `npm run build` in the orca-office checkout (or use Vite: npm run dev:client).\n');
      return;
    }
  }
  res.writeHead(404, PAGE_HEADERS).end();
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 8 * 1024 * 1024,
  // The page asks for the office protocol plus its token; the answer names only the protocol.
  handleProtocols: (protocols) => (protocols.has(CLIENT_PROTOCOL) ? CLIENT_PROTOCOL : false),
});

server.on('upgrade', (req, socket, head) => {
  const peer = hostAllowed(req.headers.host, config.port) ? checkUpgrade(req.url, req.headers.origin, clientOrigins) : null;
  if (!peer) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  if (peer === 'client' && !clientAuthorized(loadOrCreateClientToken(), req.headers['sec-websocket-protocol'])) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
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
const cli = orcaCli();
const poller = new CliPoller(cli, {
  agents: (host, list) => (model.applyAgents(host, list.agents, Date.now()), changed()),
  bots: (bots) => (model.applyBots(bots), changed()),
  terminals: (list) => model.applyTerminals(list),
  worktrees: (list) => (model.applyWorktrees(list), changed()),
  error: (what) => logOnce(what),
});

// Orchestration Runs and the mailbox (#29, #30, #33, #34): project rooms on the roof and deliveries.
const runsPoller = new RunsPoller(cli, {
  runs: (runs, now) => (model.applyRuns(runs, now), changed()),
  inbox: (messages, now) => (model.applyInbox(messages, now), changed()),
  error: (what) => logOnce(what),
});

const terminals = new TerminalWatch((terminalId, maxLines) => link.call('terminal.read', { terminalId, maxLines }));
const actions = new Actions(model, { call: (m, p, t) => link.call(m, p, t), cli, send: orcaSend(), resync: () => link.send({ type: 'resync' }), now: Date.now }, terminals);
const bots = new BotChats(model, { cli, sendBot: orcaBotSend(), now: Date.now });

// The repo-wide boards (#38): read through `gh` / `glab` for the floors pages are on, kept 3 min in memory.
const forgeRun = runCli();
const forge = new ForgeBoards({
  adapters: [ghAdapter(forgeRun), glabAdapter(forgeRun)],
  remote: gitRemote(),
  now: Date.now,
  changed: (floor) => {
    const b = model.building();
    for (const [ws, s] of liveSessions) {
      if (s.peer.floor !== floor || ws.readyState !== ws.OPEN) continue;
      for (const m of s.forgeUpdate(b)) ws.send(JSON.stringify(m));
    }
  },
});
const forgeOf = (floor: string) => {
  const t = model.forgeTarget(floor);
  return t ? forge.board(t) : null;
};

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
    // The next snapshot has it; ask for one now (and for the worktrees' links).
    link.send({ type: 'resync' });
    poller.kickWorktrees();
  } else if (msg.type === 'event' && msg.name === 'workspace.changed') {
    // A link may have come (a PR opened from the worktree): read the links again soon.
    poller.kickWorktrees();
    return;
  } else if (msg.type === 'hook' && msg.name === 'agent.tool.before') {
    const h = parseToolHook(msg.payload, now);
    if (h) model.applySubagentStart(h);
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
  actions.tick();
  for (const [ws, s] of liveSessions) for (const m of s.update(b)) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  // Deliveries (#34): to the pages on the floor each happens on.
  for (const h of model.takeHandoffs()) {
    const out = JSON.stringify({ t: 'orca.handoff', from: h.from, to: h.to, kind: h.kind, subject: h.subject });
    for (const [ws, s] of liveSessions) if (s.peer.floor === h.floor && ws.readyState === ws.OPEN) ws.send(out);
  }
}

if (!config.stub) {
  poller.start();
  runsPoller.start();
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
  const session = new LiveSession(randomUUID().slice(0, 10), query, model.building(), forgeOf);
  liveSessions.set(ws, session);
  const send = (msgs: unknown[]) => {
    for (const m of msgs) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  send(session.welcome(model.building(), `live-${PROTOCOL_VERSION}`, link.connected));
  // What the page may make Orca do (actions.ts); the socket is the office page's (client-auth.ts).
  const page = { floor: () => session.peer.floor, send, limits: pageLimits() };
  ws.on('message', (data) => {
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof (msg as { t?: unknown }).t !== 'string') return;
    const t = (msg as { t: string }).t;
    if (Actions.handles(t)) {
      // Never logged: what is typed, prompts and comments are private.
      actions.handle(page, msg as never).catch(() => send([{ t: 'orca.result', action: 'type', ok: false, error: 'failed' }]));
      return;
    }
    if (BotChats.handles(t)) {
      // Never logged: messages to bots and their answers are private.
      bots.handle(page, msg as never).catch(() => send([{ t: 'orca.result', action: 'bot', ok: false, error: 'failed' }]));
      return;
    }
    try {
      send(session.handle(msg as never, model.building()));
    } catch {
      // A malformed message from the page: ignored.
    }
  });
  ws.on('close', () => {
    liveSessions.delete(ws);
    actions.closed(page);
    bots.closed(page);
  });
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
  if (!distReady(DEFAULT_DIST)) console.warn(`office page not built (${DEFAULT_DIST}): run npm run build, or use Vite (npm run dev:client)`);
  console.log(`orca-office bridge on http://${config.host}:${config.port}${config.stub ? ' (stub: made-up office data on /client)' : ''}${spikeLog ? ` (spike log ${spikeLog})` : ''}${spikeCalls ? ' (spike calls on)' : ''}`);
});
