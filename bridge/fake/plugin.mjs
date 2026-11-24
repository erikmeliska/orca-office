// A stand-in Orca plugin: proves itself to the bridge (same HMAC as plugin/src/worker.ts), sends a
// made-up snapshot every 10 s, acts out tool hooks for the working agents, and answers the office's
// calls (terminal text, typing echoed back, open, new tasks) with made-up results.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { WORKSPACES, screen } from './data.mjs';
import { load, reset, save } from './state.mjs';

const port = Number(process.env.ORCA_OFFICE_PORT ?? 4317);
const token = readFileSync(join(homedir(), '.orca-office', 'token'), 'utf8').trim();
const hmac = (role, a, b) => createHmac('sha256', token).update(`orca-office|${role}|${a}|${b}`).digest('hex');
const CYCLE = [
  ['p-ada:leaf', 'term_ada', 'repo-demo-web::/code/demo-web/fix-login', [['Read', 'read'], ['Edit', 'edit'], ['Bash', 'test']]],
  ['p-bo:leaf', 'term_bo', 'repo-demo-web::/code/demo-web/dark-mode', [['Bash', 'test', true], ['Bash', 'test', true], ['Edit', 'edit']]],
  ['p-fa:leaf', 'term_fa', 'repo-demo-api::/code/demo-api/search-speed', [['Read', 'read'], ['WebFetch', 'web'], ['Edit', 'edit']]],
];
function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/plugin`);
  const nonce = randomBytes(16).toString('hex');
  let timers = [];
  const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  const snapshot = () => send({ type: 'snapshot', at: Date.now(), tookMs: 1, truncated: false, workspaces: [...WORKSPACES, ...load().workspaces].map((w) => (load().read.includes(w.id) ? { ...w, status: { ...w.status, unread: false } } : w)), agents: {} });
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
        // Ada sends out subagents: two at once, then one comes back, then the other.
        const [, term, workspaceId] = CYCLE[0];
        const call = (n) => `task-${Math.floor(step / 6)}-${n}`;
        const phase = step % 6;
        if (phase === 0) for (const n of [1, 2]) send({ type: 'hook', name: 'agent.tool.before', at: Date.now(), payload: { agent: 'claude', workspaceId, terminalId: term, tool: 'Task', callId: call(n) } });
        if (phase === 3 || phase === 5) send({ type: 'hook', name: 'agent.tool.after', at: Date.now(), payload: { agent: 'claude', workspaceId, terminalId: term, tool: 'Task', callId: call(phase === 3 ? 1 : 2), inputKeys: [], hasOutput: true, action: null, failed: false } });
      }, 4_000));
    }
    if (m.type === 'resync') snapshot();
    if (m.type === 'call') answer(m).then((r) => send({ type: 'result', id: m.id, ...r }));
  });
  ws.on('close', () => {
    timers.forEach(clearInterval);
    timers = [];
    setTimeout(connect, 1000);
  });
  ws.on('error', () => {});
}
/** What each made-up terminal has been typed (echoed under its screen). */
const typed = new Map();
async function answer({ method, params }) {
  switch (method) {
    case 'terminal.read': {
      const t = params.terminalId;
      const name = t.replace(/^term_/, '');
      // Shows what was typed, its control keys as visible marks.
      // eslint-disable-next-line no-control-regex
      const line = (typed.get(t) ?? '').replace(/\r/g, '⏎').replace(/\x1b/g, '⎋').replace(/[\x00-\x1f\x7f]/g, '·');
      return { ok: true, value: { lines: [...screen(name), `> ${line}${Date.now() % 1000 < 500 ? '▌' : ' '}`], truncated: false } };
    }
    case 'terminal.sendText': {
      const prev = typed.get(params.terminalId) ?? '';
      typed.set(params.terminalId, params.text === '\x7f' ? prev.slice(0, -1) : (prev + params.text + (params.enter ? '\r' : '')).slice(-60));
      return { ok: true, value: { accepted: true } };
    }
    case 'workspace.open':
    case 'terminal.focus':
      return { ok: true, value: method === 'workspace.open' ? { opened: true } : { focused: true } };
    case 'workspace.create': {
      const st = load();
      const repo = params.projectId.replace(/^repo-/, '');
      const name = params.name ?? `task-${st.workspaces.length + 1}`;
      const id = `identity:wt2:local:${repo}-${name}`;
      st.workspaces.push({ id, kind: 'worktree', name, project: repo, projectId: params.projectId, path: `/code/${repo}/${name}`, branch: name, hostId: 'local', status: { state: 'active', unread: false, terminalCount: 1, lastActivityAt: Date.now() } });
      save(st);
      // The agent shows up a few seconds later, as a real one would.
      setTimeout(() => {
        const s2 = load();
        const pane = `p-new${s2.agents.length}`;
        s2.agents.push({ orcaSessionId: pane, kind: 'terminal', agent: params.agent, state: 'working', worktreeId: `repo-${repo}::/code/${repo}/${name}`, workspace: name, repo, hostId: 'local', paneKey: `${pane}:leaf`, terminal: `term_new${s2.agents.length}`, lastAssistantMessage: 'Starting on the made-up task', updatedAt: Date.now() });
        save(s2);
      }, 3000);
      return { ok: true, value: { workspaceId: `repo-${repo}::/code/${repo}/${name}` } };
    }
    default:
      return { ok: true, value: {} };
  }
}

reset();
connect();
console.log(`fake Orca plugin → ws://127.0.0.1:${port}/plugin`);
