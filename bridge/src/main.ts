import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, redactForLog } from '@orca-office/shared';
import { loadConfig } from './config.js';
import { allowedClientOrigins, checkUpgrade } from './origin.js';
import { PluginLink } from './plugin-link.js';

const config = loadConfig();
const clientOrigins = allowedClientOrigins(config.clientPort);
const link = new PluginLink();
const clients = new Set<WebSocket>();
let lastPluginHello: unknown = null;
let lastSnapshotAt: number | null = null;

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
  const json = (code: number, value: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.method === 'GET' && req.url === '/health') {
    return json(200, { ok: true, protocol: PROTOCOL_VERSION, plugin: link.connected, lastSnapshotAt, hello: lastPluginHello });
  }
  // Spike-only: drive host calls from the shell. Refused for browsers (any Origin).
  if (req.method === 'POST' && req.url === '/spike/call' && req.headers.origin === undefined) {
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
  const peer = checkUpgrade(req.url, req.headers.origin, clientOrigins);
  if (!peer) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => (peer === 'plugin' ? onPlugin(ws) : onClient(ws)));
});

function onPlugin(ws: WebSocket) {
  link.attach(ws);
  console.log('plugin connected');
  ws.on('message', (data) => {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    record(msg);
    if (msg.type === 'hello') lastPluginHello = msg;
    if (msg.type === 'snapshot') lastSnapshotAt = Date.now();
    if (msg.type === 'result') return void link.settle(msg as never);
    for (const c of clients) c.send(JSON.stringify(redactForLog(msg)));
  });
  ws.on('close', () => {
    link.detach(ws);
    console.log('plugin disconnected');
  });
}

function onClient(ws: WebSocket) {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', role: 'bridge', protocol: PROTOCOL_VERSION, plugin: link.connected }));
  ws.on('close', () => clients.delete(ws));
}

server.listen(config.port, config.host, () => {
  console.log(`orca-office bridge on http://${config.host}:${config.port}${spikeLog ? ` (spike log ${spikeLog})` : ''}`);
});
