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
| 12 | Many agents at a desk | Separate Orca sessions on one worktree are full figures with their own terminal; a desk has 1–4 seats and grows into a desk cluster. Claude Code internal subagents (Task tool) appear as small helpers around the parent, from `agent.tool.*` hooks, no terminal. Render cap 4 per desk plus a "+N" badge. |
| 13 | State mapping | working → working; blocked, waiting → needs you (strong signal above the head); done → resting; worktree without agent → empty desk. |
| 14 | v1 actions | Live terminal with typing; open in Orca; new task at an empty desk (`workspace.create` + agent + prompt); mark read and set worktree comment. No deletes, merges or terminal closing. |
| 15 | Kept from agent-office | Building, furniture, action animations (read/edit/test/failing), speech bubble with the last message, per-desk PR/issue windows, the dog. |
| 16 | Dropped from agent-office | Voice, accounts/login, meetings, whiteboard, queue, jukebox, cars, golf, its own `gh` integration, its server and providers. |
| 17 | Walls/boards | v1: per-desk linked items from Orca. v2: repo-wide board (open issues/MRs, queue) through a `ForgeAdapter` interface, first `gh` and `glab`. |
| 18 | Data flow | Trusted-worker Orca plugin connects to the bridge, sends a snapshot (`workspace.list({includeStatus})`, `agents.list`), then pushes `agent.status.changed`, `workspace.*` events and `agent.tool.*` hooks. Resync poll every ~10 s. Paired environments: bridge polls `orca agent list --json --environment X` every ~5 s, no remote plugin. Bridge → browser over WebSocket. |
| 19 | Terminal | Bridge polls `terminal.read` (~4×/s) only for the terminal currently open in the office. Typing goes through `terminal.sendText`. Special keys (Esc, Ctrl-C, arrows) to be verified in M0; fallback is buttons using `orca terminal send --interrupt` etc. |
| 20 | Privacy and network | Last assistant message shown only as a truncated bubble (~120 chars), never stored. Bridge listens on `127.0.0.1` only. A read-only LAN view (TV, phone) comes later on a separate port without actions or terminals. |
| 21 | Bridge process | Standalone Node process under launchd, survives Orca restarts and plugin reloads; shows "Orca offline" when Orca is not running. |
| 22 | Upstream | One-time copy with attribution. Later improvements from agent-office or its forks are cherry-picked by hand; no `upstream` remote. |
| 23 | Stack | TypeScript, three.js + Vite (client, as upstream), Node (bridge), vitest. |
| 24 | Bots = permanent staff | Orca bots (ReleaseBot, SupportBot, Orchestrator, …) are permanent named characters with a stable look, nameplate and specialty icon. Workers (agent sessions) are temporary staff at desks. |
| 25 | Bots' home | A "Staff" floor with a personal office per bot. When a bot works on a repo or worktree it walks to that floor, desk or project room and returns home when done. Work with no repo target (Slack, Gmail, Obsidian…) happens in its own office. |
| 26 | Collaboration | Only handoffs are shown: task dispatch, `ask`, `reply`, mailbox messages, as a short delivery animation with a truncated subject. No permanent relationship lines. |
| 27 | Project room source | Built primarily from an orchestration Run (objective, tasks, gates, workers); worktree lineage is the fallback. Whoever coordinates the Run (bot or session) sits at the head. Open decision gates hang on the board as "waiting for your decision". |
| 28 | Bot interaction | Read-only in v1 (chats, last asked/answered, last activity, current location). Messaging a bot is milestone M5, after verifying Orca can accept it from outside. |
| 29 | Bot data source | The plugin API has no `bot.*` methods or events, so the bridge polls `orca bot list/chats --json` and `orca orchestration run-list/run-show/inbox --json`. |

## Architecture

```
Orca (local) ──trusted-worker plugin──► bridge (Node, launchd, 127.0.0.1)
   events: agent.status.changed,            │  ▲
   workspace.*, agent.tool.* hooks          │  │ orca agent list --json --environment X
   calls: workspace.list, agents.list,      │  └── paired environments (polling)
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
- **M5 Talk to bots**: send messages to bots from the office, once the Orca side is verified.

If M0 breaks an assumption, the plan is adjusted before M1.
