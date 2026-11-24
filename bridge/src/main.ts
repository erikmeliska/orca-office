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
}

/** How often a stub session's working workers move on to their next action. */
const STUB_TICK_MS = 4_000;

function onClient(ws: WebSocket, url: string | undefined) {
  if (config.stub) return onStubClient(ws, url);
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', role: 'bridge', protocol: PROTOCOL_VERSION, plugin: link.connected }));
  if (lastSnapshot && link.connected) ws.send(lastSnapshot);
  ws.on('close', () => clients.delete(ws));
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
