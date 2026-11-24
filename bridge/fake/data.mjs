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
