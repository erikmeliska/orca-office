// A stand-in Orca plugin: proves itself to the bridge (same HMAC as plugin/src/worker.ts), sends a
// made-up snapshot every 10 s and acts out tool hooks for the working agents.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { WORKSPACES } from './data.mjs';

const port = Number(process.env.ORCA_OFFICE_PORT ?? 4317);
const token = readFileSync(join(homedir(), '.orca-office', 'token'), 'utf8').trim();
const hmac = (role, a, b) => createHmac('sha256', token).update(`orca-office|${role}|${a}|${b}`).digest('hex');
const CYCLE = [
  ['p-ada', 't-ada', 'repo-demo-web::/code/demo-web/fix-login', [['Read', 'read'], ['Edit', 'edit'], ['Bash', 'test']]],
  ['p-bo', 't-bo', 'repo-demo-web::/code/demo-web/dark-mode', [['Bash', 'test', true], ['Bash', 'test', true], ['Edit', 'edit']]],
  ['p-fa', 't-fa', 'repo-demo-api::/code/demo-api/search-speed', [['Read', 'read'], ['WebFetch', 'web'], ['Edit', 'edit']]],
];
function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`);
  const nonce = randomBytes(16).toString('hex');
  let timers = [];
  const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  const snapshot = () => send({ type: 'snapshot', at: Date.now(), tookMs: 1, truncated: false, workspaces: WORKSPACES, agents: {} });
  ws.on('open', () => send({ type: 'challenge', nonce }));
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.type === 'auth') {
      if (m.proof !== hmac('bridge', nonce, m.nonce)) return ws.close();
      send({ type: 'auth', proof: hmac('plugin', m.nonce, nonce) });
      send({ type: 'hello', role: 'plugin', protocol: 0, runtime: { fake: true } });
      snapshot();
      let step = 0;
      timers.push(setInterval(snapshot, 10_000));
      timers.push(setInterval(() => {
        step++;
        for (const [pane, term, workspaceId, tools] of CYCLE) {
          const [tool, action, failed] = tools[step % tools.length];
          send({ type: 'event', name: 'agent.status.changed', at: Date.now(), payload: { paneKey: pane, terminalId: term, workspaceListId: null, state: 'working', receivedAt: Date.now() } });
          send({ type: 'hook', name: 'agent.tool.after', at: Date.now(), payload: { agent: 'claude', workspaceId, terminalId: term, tool, inputKeys: [], hasOutput: true, action, failed: !!failed } });
        }
      }, 4_000));
    }
    if (m.type === 'resync') snapshot();
  });
  ws.on('close', () => {
    timers.forEach(clearInterval);
    timers = [];
    setTimeout(connect, 1000);
  });
  ws.on('error', () => {});
}
connect();
console.log(`fake Orca plugin → ws://127.0.0.1:${port}/plugin`);
