#!/usr/bin/env node
// A stand-in `orca` CLI (ORCA_BIN) that answers what the bridge polls and does with made-up data.
import { readFileSync } from 'node:fs';
import { AGENTS, BOTS, BOT_CHATS, GATES, PORTS, REMOTE, RUN, TASKS, TERMINALS, WORKERS, WORKSPACES, WORKTREES, inbox } from './data.mjs';
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
/** A bot's chats: the made-up ones and those the office started (M5). */
const botChats = (bot) => [...(BOT_CHATS[bot] ?? []), ...(st.botChats[bot] ?? [])];
/**
 * A fake bot's conversation: its made-up entries, then each message the office sent with, after 2 s,
 * the bot working for 5 s and then a made-up answer.
 */
function botConversation(chat) {
  const entries = [...chat.entries];
  let state = 'done';
  for (const m of st.botMail.filter((x) => x.chatId === chat.id)) {
    const age = Date.now() - m.at;
    entries.push({ kind: 'message', role: 'user', text: `──── From: ORCA-OFFICE (orca-office) (handoff) ────\nSubject: ${m.subject}\n${m.body}\n[Payload: {"botRequest":{"kind":"made-up"}}]\n${'─'.repeat(60)}` });
    if (age < 2000) state = 'done';
    else if (age < 7000) {
      entries.push({ kind: 'tool', name: 'Read', state: 'running' });
      state = 'working';
    }    else entries.push({ kind: 'tool', name: 'Read', state: 'completed' }, { kind: 'message', role: 'assistant', text: `Got it. This is a **made-up answer** from the fake bot: nothing real was asked.` });
  }
  return { orcaSessionId: chat.id, kind: 'chat', agent: 'claude', source: 'chat', state, limited: false, entries };
}
if (args.startsWith('agent list') && args.includes('--environment')) out({ agents: REMOTE, hostScope: { hostIds: ['runtime:demo'] }, truncated: false });
else if (args.startsWith('agent list')) out({ agents: [...AGENTS, ...st.agents], hostScope: { hostIds: ['local'], omittedHostSelectors: [{ hostId: 'runtime:demo', selector: '--environment demo.example' }] }, truncated: false });
else if (args.startsWith('terminal list')) out({ terminals: [...TERMINALS, ...st.agents.map((a) => ({ handle: a.terminal, tabId: a.paneKey.split(':')[0], leafId: a.paneKey.split(':')[1], executionHostId: 'local' }))], truncated: false });
else if (args.startsWith('ports')) out({ platform: 'darwin', scannedAt: Date.now(), ports: PORTS.map(({ cmdline: _c, title: _t, ...p }) => p), executionHostId: 'local' });
else if (args.startsWith('bot list')) out({ bots: BOTS });
else if (args.startsWith('bot chats')) out({ bot: flag('--bot'), chats: botChats(flag('--bot')).map(({ entries: _e, ...c }) => ({ ...c, lastAsked: 'made-up', lastSaid: 'made-up', self: false, closed: false })) });
else if (args.startsWith('orchestration send')) {
  // A message to a fake bot (M5): from the office, as a handoff, the body on stdin.
  const to = flag('--to') ?? '';
  const bot = to.startsWith('bot:') ? to.slice(4) : '';
  const chatId = flag('--chat');
  if (!flag('--from')) {
    console.log(JSON.stringify({ ok: false, error: { code: 'no_active_sender_terminal', message: 'fake' } }));
    process.exit(1);
  }
  if (!BOTS.some((b) => b.name === bot) || flag('--type') !== 'handoff' || !chatId) {
    console.log(JSON.stringify({ ok: false, error: { code: 'invalid_argument', message: 'fake' } }));
    process.exit(1);
  }
  const subject = flag('--subject') ?? '';
  const body = flag('--body-file') === '-' ? readFileSync(0, 'utf8') : (flag('--body') ?? '');
  let id = chatId;
  if (chatId === 'new') {
    id = `chat-new-${Date.now().toString(36)}`;
    st.botChats[bot] = [...(st.botChats[bot] ?? []), { id, title: subject, home: false, lastActivityAt: Date.now(), entries: [] }];
  } else if (!botChats(bot).some((c) => c.id === chatId)) {
    console.log(JSON.stringify({ ok: false, error: { code: 'chat_not_found', message: 'fake' } }));
    process.exit(1);
  }
  st.botMail.push({ chatId: id, subject, body: body.slice(0, 2000), at: Date.now() });
  save(st);
  out({ messageId: `msg_fake_${st.botMail.length}`, next: 'fake' });
}
else if (args.startsWith('orchestration run-list')) out({ runs: [{ id: RUN.id, objective: RUN.objective }] });
else if (args.startsWith('orchestration run-show')) out({ run: { ...RUN, updated_at: new Date().toISOString() } });
else if (args.startsWith('orchestration task-list')) out({ tasks: TASKS, runId: RUN.id });
else if (args.startsWith('orchestration gate-list')) out({ gates: GATES, runId: RUN.id });
else if (args.startsWith('orchestration worker-list')) out({ workers: WORKERS, scope: { run: RUN.id, source: 'flag' } });
else if (args.startsWith('orchestration inbox')) out({ messages: inbox() });
else if (args.startsWith('worktree list')) out({ worktrees: [...WORKTREES, ...st.workspaces.map((w) => ({ id: `${w.projectId}::${w.path}`, repoId: w.projectId, projectId: w.projectId, isMainWorktree: false, path: w.path, hostId: 'local', displayName: w.name, linkedItems: [], childWorktreeIds: [] }))], totalCount: WORKTREES.length, truncated: false });
else if (args.startsWith('agent read') && BOTS.some((b) => botChats(b.name).some((c) => c.id === argv[2]))) {
  out(botConversation(BOTS.flatMap((b) => botChats(b.name)).find((c) => c.id === argv[2])));
} else if (args.startsWith('agent read')) {
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
