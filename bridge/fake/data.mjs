// Made-up Orca for screenshots and demos (npm run dev:fake): nothing here is real.
export const NOW = Date.now();
const wt = (repo, name, extra = {}) => ({ id: `identity:wt2:local:${repo}-${name}`, kind: 'worktree', name, project: repo, projectId: `repo-${repo}`, path: `/code/${repo}/${name}`, branch: name, hostId: 'local', status: { state: 'active', unread: false, terminalCount: 1, lastActivityAt: NOW }, ...extra });
export const WORKSPACES = [
  wt('demo-web', 'main'),
  wt('demo-web', 'fix-login'),
  wt('demo-web', 'dark-mode'),
  wt('demo-web', 'settings-migration', { status: { state: 'active', unread: true, terminalCount: 1, lastActivityAt: NOW } }),
  wt('demo-web', 'readme'),
  wt('demo-api', 'main'),
  wt('demo-api', 'search-speed'),
  { id: 'folder:bot-release', kind: 'folder', name: 'ReleaseBot', project: null, path: '/home/demo/.orca/bots/releasebot', branch: null, hostId: null, status: { state: 'inactive', unread: false, terminalCount: 0, lastActivityAt: null } },
  { id: 'folder:bot-support', kind: 'folder', name: 'SupportBot', project: null, path: '/home/demo/.orca/bots/supportbot', branch: null, hostId: null, status: { state: 'inactive', unread: false, terminalCount: 0, lastActivityAt: null } },
];
const ag = (pane, repo, name, kind, state, said) => ({ orcaSessionId: pane, kind, agent: 'claude', state, worktreeId: `repo-${repo}::/code/${repo}/${name}`, workspace: name, repo, hostId: 'local', paneKey: pane, lastAssistantMessage: said, updatedAt: NOW });
export const AGENTS = [
  ag('p-ada', 'demo-web', 'fix-login', 'terminal', 'working', 'Tracing why expired sessions still reach the dashboard'),
  ag('p-bo', 'demo-web', 'dark-mode', 'terminal', 'working', 'Running the test suite again'),
  ag('p-bo2', 'demo-web', 'dark-mode', 'chat', 'done', 'The palette tokens are in, contrast checks pass'),
  ag('p-cy', 'demo-web', 'settings-migration', 'terminal', 'blocked', 'May I drop the old settings column? It still has 12 rows.'),
  ag('p-di', 'demo-web', 'readme', 'chat', 'done', 'Wrote the new install steps'),
  ag('p-fa', 'demo-api', 'search-speed', 'terminal', 'working', 'Reading the query planner output'),
  { ...ag('p-bot', '', '', 'chat', 'working', 'Tagging v1.4.0 and drafting the release notes'), worktreeId: 'folder:bot-release', workspace: 'ReleaseBot', repo: null },
];
export const REMOTE = [{ ...ag('p-env', 'demo-api', 'nightly', 'terminal', 'working', 'Rebuilding the search index on the server'), hostId: 'runtime:demo', workspace: 'nightly' }];
export const BOTS = [
  { id: 'b-release', name: 'ReleaseBot', agent: 'claude', paused: false, specialty: 'Ships releases and writes the notes', chats: { count: 3 } },
  { id: 'b-support', name: 'SupportBot', agent: 'claude', paused: false, specialty: 'Answers support tickets', chats: { count: 1 } },
  { id: 'b-review', name: 'ReviewBot', agent: 'codex', paused: false, specialty: 'Reviews pull requests', chats: { count: 0 } },
];

// The bots' chats (M5, #37), as `orca bot chats` lists them, with a made-up conversation each.
const said = (role, text) => ({ kind: 'message', role, text });
export const BOT_CHATS = {
  ReleaseBot: [
    { id: 'p-bot', title: 'Home', home: true, lastActivityAt: NOW - 60_000, entries: [said('user', 'Tag v1.4.0 once the checks are green.'), { kind: 'tool', name: 'Bash', state: 'completed' }, said('assistant', 'Checks are green. **v1.4.0** is tagged and the release notes are drafted.')] },
    { id: 'chat-release-notes', title: 'Release notes wording', home: false, lastActivityAt: NOW - 3600_000, entries: [said('user', 'Keep the notes short, one line per change.'), said('assistant', 'Will do: one line per change, grouped by *Added*, *Fixed* and *Changed*.')] },
  ],
  SupportBot: [{ id: 'chat-support-home', title: 'Home', home: true, lastActivityAt: NOW - 7200_000, entries: [said('user', 'Anything new in the queue?'), said('assistant', 'Two made-up tickets, both answered.')] }],
};

// Terminal handles by pane, as `orca terminal list` gives them.
export const TERMINALS = AGENTS.filter((a) => a.kind === 'terminal').map((a) => ({ handle: `term_${a.paneKey.slice(2)}`, tabId: a.paneKey, leafId: 'leaf', executionHostId: 'local' }));
for (const a of AGENTS) if (a.kind === 'terminal') a.paneKey = `${a.paneKey}:leaf`;

/** What a made-up terminal shows. */
export function screen(name) {
  return [
    `~/code/demo-web/${name} (${name})`,
    '',
    '╭──────────────────────────────────────────────╮',
    '│ ✻ Welcome to the made-up agent               │',
    '╰──────────────────────────────────────────────╯',
    '',
    '> Fix the login redirect after the session expires',
    '',
    '● Read(src/auth/session.ts)',
    '  ⎿  Read 84 lines',
    '● Edit(src/auth/session.ts)',
    '  ⎿  Updated with 3 additions and 1 removal',
    '● Bash(npm test)',
    '  ⎿  Test Files  12 passed (12)',
    '',
    '✶ Thinking… (esc to interrupt)',
  ];
}

// What `orca worktree list --json` links to the made-up worktrees (#32): made-up forges and numbers.
const gh = (type, number, title) => ({ provider: 'github', type, number, url: `https://github.com/example/demo-web/${type === 'pr' ? 'pull' : 'issues'}/${number}`, title, origins: [] });
const row = (repo, name, over = {}) => ({ id: `repo-${repo}::/code/${repo}/${name}`, repoId: `repo-${repo}`, path: `/code/${repo}/${name}`, hostId: 'local', displayName: name, linkedPR: null, linkedIssue: null, linkedGitLabMR: null, linkedGitLabIssue: null, linkedLinearIssue: null, linkedLinearIssueOrganizationUrlKey: null, linkedWorkItem: null, linkedItems: [], parentWorktreeId: null, childWorktreeIds: [], lineage: null, ...over });
export const WORKTREES = [
  row('demo-web', 'main'),
  row('demo-web', 'fix-login', { linkedPR: 128, linkedIssue: 97, linkedItems: [gh('pr', 128, 'Redirect to the login page when the session expires'), gh('issue', 97, 'Expired sessions land on a blank dashboard')] }),
  row('demo-web', 'dark-mode', { linkedLinearIssue: 'WEB-311', linkedLinearIssueOrganizationUrlKey: 'example', linkedItems: [gh('pr', 131, 'Dark mode palette tokens')] }),
  row('demo-web', 'settings-migration', { linkedWorkItem: { key: 'OPS-42', url: 'https://example.atlassian.net/browse/OPS-42', title: 'Move settings to the new table' } }),
  row('demo-web', 'readme', { linkedItems: [{ provider: 'github', type: 'issue', number: 88, title: 'Install steps are out of date' }] }),
  row('demo-api', 'main'),
  row('demo-api', 'search-speed', { linkedGitLabMR: 17, linkedItems: [{ provider: 'gitlab', type: 'issue', number: 9, url: 'https://gitlab.com/example/demo-api/-/issues/9', title: 'Search takes 4 s on big accounts' }] }),
];

// A made-up orchestration Run (#29, #30): ReleaseBot coordinates (it mails the workers), two
// workers on two repos, a decision gate waiting for you, and mail coming in every few seconds (#34).
export const RUN = { id: 'run_demo', objective: 'Ship dark mode across the web app and the API', coordinator_handle: null, legacy: 0, created_at: new Date(NOW - 3600_000).toISOString(), updated_at: new Date(NOW).toISOString() };
export const TASKS = [
  { id: 'task_web', status: 'dispatched', title: 'Dark palette tokens in the web app' },
  { id: 'task_api', status: 'dispatched', title: 'Theme preference in the API' },
  { id: 'task_docs', status: 'ready', title: 'Document the theme switch' },
  { id: 'task_audit', status: 'completed', title: 'Audit hard-coded colors' },
];
export const GATES = [{ id: 'gate_1', taskId: 'task_web', status: 'pending', question: 'Use the new palette for the charts too?', options: '["Yes, charts too","No, later"]' }];
export const WORKERS = [
  { dispatchId: 'ctx_web', taskId: 'task_web', state: 'running', liveness: 'alive', terminal: 'term_bo', workspace: 'repo-demo-web::/code/demo-web/dark-mode', host: 'local' },
  { dispatchId: 'ctx_api', taskId: 'task_api', state: 'running', liveness: 'alive', terminal: 'term_fa', workspace: 'repo-demo-api::/code/demo-api/search-speed', host: 'local' },
];
const MAIL = [
  ['ask', 'structworker_web', 'run:run_demo', 'Should the charts follow the dark palette?', 'ctx_web', 'task_web'],
  ['reply', 'orca_session_id:p-bot', 'dispatch:ctx_api', 'Keep the API default light for now', null, null],
  ['worker_done', 'structworker_api', 'run:run_demo', 'Theme preference stored per user', 'ctx_api', 'task_api'],
  ['escalation', 'structworker_web', 'run:run_demo', 'Contrast check fails on two buttons', 'ctx_web', 'task_web'],
];
/** The mailbox now: a status from the coordinator, then one more message every 8 s. */
export function inbox(now = Date.now()) {
  const n = Math.floor(now / 8000);
  const out = [{ id: 'msg_status', type: 'status', from: 'orca_session_id:p-bot', to: 'dispatch:ctx_web', subject: 'Started', body: 'made-up', handled: true }];
  for (let i = Math.max(0, n - 5); i <= n; i++) {
    const [type, from, to, subject, dispatchId, taskId] = MAIL[i % MAIL.length];
    out.push({ id: `msg_${i}`, type, from, to, subject, body: 'made-up', handled: false, ...(dispatchId ? { payload: { dispatchId, taskId } } : {}) });
  }
  return out.reverse();
}
