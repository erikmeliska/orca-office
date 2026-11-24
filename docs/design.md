# orca-office: design

A 3D cartoon office on top of [Orca](https://orca.dev). Orca stays the place
where agents actually run (worktrees, terminals, any agent CLI, any forge).
orca-office is a *view with light control*: you see who is working, who is
waiting for you and who is done, and you can answer an agent, open it in Orca
or start a new task without leaving the office.

The 3D client is derived from
[AgentSystemLabs/agent-office](https://github.com/AgentSystemLabs/agent-office)
(MIT), copied once from upstream commit `852e2ab` (2026-10-08). Its server is
not used.

## Decisions

| # | Topic | Decision |
|---|-------|----------|
| 1 | Audience | Solo: one person, many agents. No multiplayer, accounts, login or voice in v1. |
| 2 | Role | Overview plus light control. Orca remains the real workplace; the office opens into it. |
| 3 | Where it runs | Standalone local web page, fed by an Orca worker plugin through a local bridge. |
| 4 | Source of agents | Orca only, including agents on other hosts Orca manages (SSH hosts, paired environments). |
| 5 | Ambition | Personal tool, public on GitHub. Product decision after a month of use. |
| 6 | Office runs nothing | No PTYs, worktrees or agent processes of its own. Everything goes through Orca. |
| 7 | Code base | New repo. Copy client, 3D world, models and `src/shared/protocol` from agent-office. New bridge instead of its server. No agy or other provider code: Orca handles providers. |
| 8 | Forge | Forge-agnostic. v1 uses what Orca already links per worktree (GitHub PR/issue, GitLab MR/issue, Linear, Jira). |
| 9 | Spatial mapping | Floor = repo. Desk = worktree. Figure = Orca agent session on that worktree. Host is where it runs, shown as a tag, not a floor. |
| 10 | Cross-repo projects | Dynamic "project room" (rooftop) built from Orca workspace lineage: coordinator at the head of the table, child sessions from other repos mirrored as seats. Created when a lineage spans more than one repo or has at least 2 children. |
| 11 | Navigation | Elevator panel with per-floor badges (needs you / working). |
| 12 | Many agents at a desk | Separate Orca sessions on one worktree are full figures; terminal agents have their own terminal, chat agents (Orca chats) have none (M0). A desk has 1–4 seats and grows into a desk cluster. Claude Code internal subagents (Task tool) appear as small helpers around the parent, from `agent.tool.*` hooks, no terminal. Render cap 4 per desk plus a "+N" badge. |
| 13 | State mapping | working → working; blocked, waiting → needs you (strong signal above the head); done → resting; worktree without agent → empty desk. The bridge de-duplicates repeated events (same `paneKey` + state every ~3 s) and waits ~1 s before showing done, because a launch flickers done/working (M0). Action animations come from `agent.tool.after` and exist only for local terminal agents, not for chats or SSH (M0). |
| 14 | v1 actions | Live terminal with typing (terminal agents); last message and open in Orca (chat agents, which have no terminal); new task at an empty desk (`workspace.create` + agent + prompt); mark read and set worktree comment. No deletes, merges or terminal closing. |
| 15 | Kept from agent-office | Building, furniture, action animations (read/edit/test/failing), speech bubble with the last message, per-desk PR/issue windows, the dog. |
| 16 | Dropped from agent-office | Voice, accounts/login, meetings, whiteboard, queue, jukebox, cars, golf, its own `gh` integration, its server and providers. (The queue came back read-only in v2, #17.) |
| 17 | Walls/boards | v1: per-desk linked items from Orca. v2 (#38): repo-wide board (open issues/MRs, queue = open items no worktree works on) through a `ForgeAdapter` interface in the bridge, first `gh` and `glab`; read only, cached 3 min in memory, the CLIs keep their own login ([stub-protocol.md](stub-protocol.md#repo-board-v2-38)). |
| 18 | Data flow | Trusted-worker Orca plugin connects to the bridge, sends a snapshot (`workspace.list({includeStatus})`, `agents.list` for every non-inactive workspace), then pushes `agent.status.changed`, `workspace.*` events and `agent.tool.after` hooks. Resync every ~10 s. The worker declares a status bar item, which keeps it running (otherwise Orca stops idle workers). The bridge also polls `orca agent list --json` every ~5 s locally (last messages, chat agents) and with `--environment X` for paired environments, which `workspace.list` does not return (M0). Bridge → browser over WebSocket. |
| 19 | Terminal | Bridge polls `terminal.read` (~4×/s, ~2 ms per call) only for the terminal currently open in the office. Typing goes through `terminal.sendText` as raw bytes: Esc, Ctrl-C, Tab, Shift-Tab, arrows, Backspace and Enter (`\r`) arrive verbatim (M0), so no fallback buttons. |
| 20 | Privacy and network | Last assistant message (from `orca agent list`; the plugin API has none) shown only as a truncated bubble (~120 chars), never stored or logged; agent titles, bot chat texts, inbox messages and Run objectives count as private too (`shared/src/privacy.ts`). The worker forwards only tool names and input keys. Bridge listens on `127.0.0.1` only, rejects non-loopback `Host` headers and checks the WebSocket `Origin`: `/plugin` refuses any Origin, and worker and bridge authenticate each other by HMAC challenge-response over the token in `~/.orca-office/token` (0600), `/client` accepts only the office page and, since M3, only with the page's own token (`~/.orca-office/client-token`, handed by the page's server to a same-origin fetch only, sent as a WebSocket subprotocol; `bridge/src/client-auth.ts`). A read-only LAN view (TV, phone, #39) runs on a separate port, off by default (`ORCA_OFFICE_LAN_PORT` + `ORCA_OFFICE_LAN_HOST`): only the TV page and a socket that sends floors, desks, figures, states and badges and takes nothing but pings ([stub-protocol.md](stub-protocol.md#read-only-lan-view-v2-39)). |
| 21 | Bridge process | Standalone Node process under launchd, survives Orca restarts and plugin reloads; shows "Orca offline" when Orca is not running. It also serves the built office page (`client/dist`, only files from there) on its own port, `http://127.0.0.1:4317/`, so after a restart everything runs from launchd without Vite; `scripts/install-bridge.sh` builds the page first. Vite on 5317 stays for development. |
| 22 | Upstream | One-time copy with attribution. Later improvements from agent-office or its forks are cherry-picked by hand; no `upstream` remote. |
| 23 | Stack | TypeScript, three.js + Vite (client, as upstream), Node (bridge), vitest. |
| 24 | Bots = permanent staff | Orca bots (ReleaseBot, SupportBot, Orchestrator, …) are permanent named characters with a stable look, nameplate and specialty icon. Workers (agent sessions) are temporary staff at desks. |
| 25 | Bots' home | A "Staff" floor with a personal office per bot. When a bot works on a repo or worktree it walks to that floor, desk or project room and returns home when done. Work with no repo target (Slack, Gmail, Obsidian…) happens in its own office. |
| 26 | Collaboration | Only handoffs are shown: task dispatch, `ask`, `reply`, mailbox messages, as a short delivery animation with a truncated subject. No permanent relationship lines. |
| 27 | Project room source | Built primarily from an orchestration Run (objective, tasks, gates, workers); worktree lineage is the fallback. Whoever coordinates the Run (bot or session) sits at the head. Open decision gates hang on the board as "waiting for your decision". |
| 28 | Bot interaction | Read-only in v1 (chats, last asked/answered, last activity, working or idle). M5: a bot's figure opens its chats; a message goes out with `orca orchestration send --from orca-office --to bot:<name> --chat <id\|new> --type handoff` (body on stdin) and the answer is read from the chat with `orca agent read <chat id>`. Verified from a process outside Orca ([m5-bots.md](m5-bots.md)). |
| 29 | Bot data source | The plugin API has no `bot.*` methods or events, so the bridge polls `orca bot list/chats --json` and `orca orchestration run-list/run-show/task-list/gate-list/worker-list/inbox --json` (0.1–0.2 s each). A bot's chat is a chat agent in `orca agent list` (folder workspace named after the bot), which gives its live state. Where a bot works is not exposed (`coordinator_handle` was null in every Run), so bots stay in their office and only their dispatched workers appear at desks, until Orca exposes it (M0). M4: the mailbox does tell: a bot chat that mails a Run's dispatch coordinates that Run, so it moves to the head of the project room while the Run is live ([stub-protocol.md](stub-protocol.md#project-rooms-decisions-and-deliveries-m4-29-30-33-34)). |

## Architecture

```
Orca (local) ──trusted-worker plugin──► bridge (Node, launchd, 127.0.0.1)
   events: agent.status.changed,            │  ▲
   workspace.*, agent.tool.after hook       │  │ orca agent list --json [--environment X]
   calls: workspace.list, agents.list,      │  └── last messages, chats, paired environments (polling)
   terminal.read/sendText, workspace.create │
                                            │  ▲
                                            │  └── orca bot … / orchestration … --json (polling)
                                            ▼
                                  browser: 3D office (WebSocket)
```

## Milestones

- **M0 Spike**: hello-world worker plugin sends events to a bridge; verify special keys via `sendText`, status events for SSH hosts, filtering of `lastAssistantMessage`, outbound network from the worker.
- **M1 Client boots**: copied client starts against a stub bridge, without login and dropped features.
- **M2 Live office**: real floors, desks and figures with states and action animations from Orca, including remote environments; Staff floor with bots.
- **M3 Light control**: terminal with typing, open in Orca, new task, mark read and comment.
- **M4 Projects and navigation**: project room from orchestration Runs (lineage fallback), decision gates, elevator badges, per-desk boards, bots walking to their work, handoff animations.
- **M5 Talk to bots**: send messages to bots from the office; the Orca route is in [m5-bots.md](m5-bots.md).

If M0 breaks an assumption, the plan is adjusted before M1.

M1 is done: the client runs against the stub bridge ([stub-protocol.md](stub-protocol.md)); besides the features in #16, the 2D `/lite` view, the board agents at the kiosks and the character select before entering went too (they need agent-office's server or login). M3 (light control) is in [stub-protocol.md](stub-protocol.md#light-control-m3). M0 is done: findings in [spike-m0.md](spike-m0.md). Open point: status events for agents on SSH hosts could not be observed (no SSH worktrees yet); the 10 s resync covers them until re-tested.
