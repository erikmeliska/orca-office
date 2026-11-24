# M0 spike report

Run on 2026-11-24 against Orca 1.4.272 (plugin host API 1.10) on macOS, with
the `plugin/` worker and `bridge/` from this branch. Decisions that changed are
written back into [design.md](design.md).

## How to reproduce

```sh
ORCA_OFFICE_SPIKE_LOG=1 ORCA_OFFICE_SPIKE_CALLS=1 npm run start -w bridge
orca plugin dev load plugin --json                  # prints the approval fingerprint
orca plugin dev load plugin --approve <fingerprint>
curl -s 127.0.0.1:4317/health
curl -s -X POST -H "Authorization: Bearer $(cat ~/.orca-office/token)" \
  127.0.0.1:4317/spike/call -d '{"method":"workspace.list","params":{"includeStatus":true}}'
```

`/spike/call` exists only with `ORCA_OFFICE_SPIKE_CALLS=1`, needs the token
and is refused for any request with an `Origin` header (browsers). During the
spike the worker also allowed `terminal.create` to open the key-echo terminal;
it was removed afterwards.

## #2 Worker → bridge

| Question | Answer |
|----------|--------|
| Outbound network from a `trusted-worker` | Works. The worker is Node v24.22.1 with the global `WebSocket`; it connects to `ws://127.0.0.1:4317/plugin`. |
| Keeping the worker alive | An idle worker is stopped and restarted on the next event. A plugin with `main` **and** `contributes.statusBarItems` keeps its worker running while enabled, so the plugin declares an "Office" status bar item (it also shows connected / offline). |
| Reconnect | `orca plugin restart` → new connection within ~1 s. Bridge restart → plugin reconnects with backoff (1 s, 2 s, … 30 s), observed within 4 s. `plugin dev reload` without file changes does not restart the worker. |
| Snapshot cost | `workspace.list({includeStatus})` for 130 workspaces: ~5 ms. Full snapshot including `agents.list` for the 14 non-inactive workspaces: ~200 ms. |
| `terminal.read` cost | p50 1.6 ms, p95 2 ms (200 lines). Polling 4×/s for one open terminal is cheap. |

Payload notes:

- `agent.status.changed` carries `workspaceId` in the worktree form
  (`<repoId>::<path>`), `workspaceListId` (the `workspace.list` id, use this as
  the key), `paneKey`, `terminalId`, `title`, `state`, `mainAgent`,
  `sessionId` and an undocumented `worktreeId`.
- The same state is re-sent every ~3.4 s while an agent works and around tool
  calls. The bridge must de-duplicate by `paneKey` + `state`.
- A terminal agent's start emits `done → working → done → working` within
  150 ms. Debounce ~1 s before showing "done".
- **Chat agents** (Orca chats, including every bot chat) have no terminal:
  `terminalId: null`, the workspace has `terminalCount: 0` but state
  `working`. They do send `agent.status.changed`.
- `agent.tool.after` fires for terminal Claude Code agents (seen: `Read`,
  `Bash`, with `callId`). It does **not** fire for chat agents. The worker
  forwards only the tool name and input keys, never input or output.
- `title` is generated from the first prompt ("Spike test bridge README"), so
  it is private text (see #6).

## #3 Special keys through `terminal.sendText`

Tested on a raw-mode stdin echo program (`bridge/spike/keyecho.mjs`) in a
terminal the plugin opened. Every byte arrives verbatim:

| Key | Sent | Received |
|-----|------|----------|
| Esc | `\x1b` | `1b` |
| Ctrl-C | `\x03` | `03` |
| Tab / Shift-Tab | `\t` / `\x1b[Z` | `09` / `1b 5b 5a` |
| Arrows | `\x1b[A` … `\x1b[D` | `1b 5b 41` … `1b 5b 44` |
| Backspace | `\x7f` | `7f` |
| Enter | `\r` or `enter: true` | `0d` (with `enter: true` as a separate write) |

No fallback buttons are needed. TUIs such as Claude Code and Codex read the
same bytes from the PTY. Note: the CLI's `orca terminal send --enter`
bracket-pastes prompts to a recognised agent; the office sends keystrokes raw
and Enter as `\r`.

## #4 Agents on SSH hosts and paired environments

- This Orca has 10 saved SSH targets but **no SSH worktrees** (all 122
  worktrees are `local`), so status events for `ssh:` hosts could not be
  observed. Not verified.
- `workspace.list` is documented to include `ssh:` and `runtime:` rows; here
  it returned only `local` and folder rows (`hostId: null`), and **no rows for
  the paired environment** `public.ixy.sk`.
- Paired environments: `orca agent list --json --environment <id>` works and
  takes ~0.65 s. Bridge polling every ~5 s per environment stays the plan.
- Fallback for SSH stays: the 10 s `workspace.list({includeStatus})` resync.
  `agent.tool.*` is documented as not covering SSH, so SSH agents get no action
  animations. Re-test when the first SSH worktree exists.

## #5 Bot and orchestration data from the CLI

All commands below take 0.1–0.2 s each.

| Command | Shape (relevant fields) |
|---------|-------------------------|
| `orca bot list --json` | `bots[]`: `id`, `name`, `agent`, `paused`, `linked[]`, `specialty` (≤120 chars), `chats.count` |
| `orca bot chats --bot <name> --json` | `chats[]`: `id`, `title`, `lastActivityAt`, `lastAsked`, `lastSaid` (≤200 chars, private), `home`, `closed` |
| `orca agent list --json` | `agents[]`: `orcaSessionId`, `kind` (`chat`/`terminal`), `agent`, `state`, `worktreeId`, `workspace`, `hostId`, `paneKey`, `title`, `lastAssistantMessage` (≤200 chars), `updatedAt`; `hostScope.omittedHostSelectors` names the `--environment` for other hosts |
| `orca orchestration run-list --json` | `runs[]`: `id`, `objective` |
| `orca orchestration run-show --id <run> --full --json` | `run`: `objective`, `coordinator_handle`, `created_at`, `updated_at` |
| `orca orchestration task-list --run <run> --json` | `tasks[]`: `id`, `status`, `title` |
| `orca orchestration gate-list --run <run> --json` | `gates[]` (none open during the spike) |
| `orca orchestration worker-list --json` | `workers[]`: `dispatchId`, `taskId`, `state`, `liveness`, `terminal`, `workspace` (worktree id), `host` |
| `orca orchestration inbox --json` | `messages[]`: `id`, `type`, `from`, `to` (`run:…`, `dispatch:…`), `subject`, `body`, `payload.{taskId,dispatchId}`, `handled` |

Answers:

- **Bot state**: each bot chat is a chat agent in `orca agent list`, in a
  folder workspace named after the bot (`workspace: "ReleaseBot"`). Its
  `state` says whether the bot is working, and `paneKey` joins it with the
  plugin's `agent.status.changed` events.
- **Where a bot works**: not exposed. `coordinator_handle` was `null` in every
  sampled Run, so a Run cannot be tied to a bot reliably. A bot's work is
  visible only through the workers it dispatches (`worker-list.workspace`).
  For M4 (#33) the bot stays in its own office and the dispatched worker shows
  up at the target desk, unless Orca exposes the coordinator.
- **Handoffs**: inbox message types seen: `worker_done`, `status`,
  `escalation`; `ask`/`reply` and dispatch are the same mailbox. New rows in
  `worker-list` mark a dispatch.
- **Messaging a bot from outside (M5, #36)**: `orca orchestration send --to
  bot:<name> [--chat <id>] --type question|handoff` mails a bot chat. Verified
  in M5 from a process outside Orca: it needs `--from <handle>`, and the answer
  is read from the chat; see [m5-bots.md](m5-bots.md).

## #6 Privacy filter

Private text reaches the bridge only through the CLI (`lastAssistantMessage`,
`lastAsked`, `lastSaid`, inbox `subject`/`body`, Run `objective`) and agent
`title`s. The plugin API never carries assistant messages.

- `shared/src/privacy.ts`: `toBubble()` cuts text to one line of ≤120
  characters for display; `redactForLog()` replaces every private field with
  its length before anything is logged or broadcast.
- The worker sends only tool names and input keys from `agent.tool.after`.
- The bridge keeps no history on disk. The spike log is opt-in
  (`ORCA_OFFICE_SPIKE_LOG=1`), redacted and git-ignored.
- `/plugin` refuses any upgrade with an `Origin` header and `/client` accepts
  only the office page's origin, because any website can open
  `ws://127.0.0.1`.
- Loopback is open to every local process and user, so worker and bridge
  authenticate each other: the bridge writes `~/.orca-office/token` (0600,
  folder 0700) and both sides prove they know it with HMACs over each other's
  random nonces (`bridge/src/auth.ts`). The token never crosses the socket.
  The worker sends no data and obeys no call before the bridge has proved
  itself, so a process squatting the port while the bridge is down gets only a
  random nonce (tested: the worker closes with 4001). Requests whose
  `Host` is not `127.0.0.1`/`localhost` get 421 (DNS rebinding). Call ids are
  random UUIDs.
- The worker allows only `workspace.list`, `agents.list`, `terminal.list`,
  `terminal.read` and `terminal.sendText` from the bridge, and checks
  `terminal.sendText` params (a `term_` id, text ≤4096 chars). The `/client`
  side gets its own token in M1/M3, before any terminal action reaches the
  browser.
