#!/usr/bin/env node
// A stand-in `orca` CLI (ORCA_BIN) that answers what the bridge polls and does with made-up data.
import { AGENTS, BOTS, REMOTE, TERMINALS, WORKSPACES } from './data.mjs';
import { load, save } from './state.mjs';
const argv = process.argv.slice(2);
const args = argv.join(' ');
const out = (result) => console.log(JSON.stringify({ id: 'fake', ok: true, result }));
const flag = (name) => {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return argv[i].includes('=') ? argv[i].slice(name.length + 1) : argv[i + 1];
};
const st = load();
if (args.startsWith('agent list') && args.includes('--environment')) out({ agents: REMOTE, hostScope: { hostIds: ['runtime:demo'] }, truncated: false });
else if (args.startsWith('agent list')) out({ agents: [...AGENTS, ...st.agents], hostScope: { hostIds: ['local'], omittedHostSelectors: [{ hostId: 'runtime:demo', selector: '--environment demo.example' }] }, truncated: false });
else if (args.startsWith('terminal list')) out({ terminals: [...TERMINALS, ...st.agents.map((a) => ({ handle: a.terminal, tabId: a.paneKey.split(':')[0], leafId: a.paneKey.split(':')[1], executionHostId: 'local' }))], truncated: false });
else if (args.startsWith('bot list')) out({ bots: BOTS });
else if (args.startsWith('agent read')) {
  // A made-up conversation for any chat agent; it is still working every other 10 s.
  const working = Math.floor(Date.now() / 10_000) % 2 === 0;
  out({
    orcaSessionId: argv[2],
    kind: 'chat',
    agent: 'claude',
    source: 'chat',
    state: working ? 'working' : 'done',
    limited: false,
    entries: [
      { kind: 'message', role: 'user', text: 'Can you switch the app to **dark mode** tokens?' },
      { kind: 'tool', name: 'Read', state: 'completed' },
      { kind: 'tool', name: 'Edit', state: 'completed' },
      { kind: 'message', role: 'assistant', text: 'Done. The palette now comes from tokens:\n\n- `--bg` and `--fg` per theme\n- contrast checked for **AA**\n\n```css\n:root[data-theme=dark] { --bg: #1d1d1d; }\n```' },
      { kind: 'message', role: 'user', text: 'And the charts?' },
      ...(working ? [{ kind: 'tool', name: 'Bash', state: 'running' }] : [{ kind: 'message', role: 'assistant', text: 'The charts use the same tokens now. ![made-up chart](https://example.com/chart.png)' }]),
    ],
  });
} else if (args.startsWith('terminal send')) {
  // What the office types: kept per terminal for the fake plugin's terminal.read to show.
  const t = flag('--terminal');
  const text = flag('--text') ?? '';
  const prev = st.typed[t] ?? '';
  st.typed[t] = (text === '\x7f' ? prev.slice(0, -1) : prev + text + (argv.includes('--enter') ? '\r' : '')).slice(-60);
  save(st);
  out({ send: { handle: t, accepted: true, bytesWritten: text.length } });
} else if (args.startsWith('worktree set')) {
  const id = flag('--worktree');
  if (![...WORKSPACES, ...st.workspaces].some((w) => w.id === id)) {
    console.error('fake orca: no such worktree');
    process.exit(1);
  }
  if (argv.includes('--read')) st.read = [...new Set([...st.read, id])];
  const comment = flag('--comment');
  if (comment !== undefined) st.comments[id] = comment;
  save(st);
  out({ worktree: { id } });
} else if (args.startsWith('worktree show')) {
  const id = flag('--worktree');
  const w = [...WORKSPACES, ...st.workspaces].find((x) => x.id === id);
  if (!w) process.exit(1);
  out({ worktree: { id, comment: st.comments[id] ?? '', isUnread: !!w.status?.unread && !st.read.includes(id) } });
} else {
  console.error(`fake orca: ${args} not faked`);
  process.exit(2);
}
