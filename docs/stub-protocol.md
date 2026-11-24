# Stub bridge protocol (M1)

`npm run dev` starts the bridge in stub mode (`ORCA_OFFICE_STUB=1`, `npm run dev:stub`) next to Vite.
In stub mode the bridge plays the office server for the 3D client with made-up data
(`bridge/src/stub.ts`), so the office boots without Orca. The plugin side (`/plugin`, HMAC
handshake) is unchanged; nothing the plugin sends reaches a stub page.

The wire format is agent-office's: one JSON object per WebSocket frame, typed by
`ServerMsg` / `ClientMsg` in `shared/src/office/protocol.ts`. The page connects to
`ws://127.0.0.1:<ORCA_OFFICE_PORT>/client` (default 4317); `/client` accepts only the office
page's origin, `http://127.0.0.1:<ORCA_OFFICE_CLIENT_PORT>` or `localhost` (default 5317).
Since M3 the socket must also present the page's token (`bridge/src/client-auth.ts`): the page
fetches it from its own server at `/__orca-office/token` (Vite hands it only to a same-origin fetch,
`client/vite-token.ts`) and asks for the subprotocols `orca-office` and `token.<hex>`; without it the
upgrade gets 401. The token lives in `~/.orca-office/client-token` (0600), apart from the plugin's key.

| Variable | Default | What |
|----------|---------|------|
| `ORCA_OFFICE_PORT` | 4317 | Bridge port; the client is built against it. |
| `ORCA_OFFICE_CLIENT_PORT` | 5317 | Vite port (`strictPort`), the only origin `/client` accepts. |
| `ORCA_OFFICE_STUB` | unset | `1`: stub mode. |

## Data

Two floors, `demo-web` (`stub-web`) and `demo-api` (`stub-api`), plus the roof. Workers, all
`kind: 'agent'`, provider `claude`:

| Floor | Desk | Worker | Status | Action cycle |
|-------|------|--------|--------|--------------|
| demo-web | desk-1 | Ada | working | read → edit → test |
| demo-web | desk-2 | Bo | working | test → failing → edit |
| demo-web | desk-3 | Cy | needs_input | |
| demo-web | desk-4 | Di | done | |
| demo-web | desk-6 | Ed | idle | |
| demo-api | desk-1 | Fa | working | read → web → edit |
| demo-api | desk-2 | Gu | needs_input | |
| demo-api | desk-5 | Ha | done | |

Each floor has its dog (Rex, a corgi, sitting). Issues, pull requests, pictures, services, the
cabinet's high scores and the jail are empty.

## Server → page (implemented)

| Message | When |
|---------|------|
| `welcome` | On connect. The whole building (`floors`, `projectsDir`, `version: 'stub'`, `me: { admin: true }`, sky, theme `off`, map `office`, empty chat, usage, limits, prompts, notify, machine) and the page's floor (`FloorView`). `peers` holds only the page itself, back where it stood if the query names the floor and a spot (`floor`, `x`, `y`, `z`, `rotY`), else in the elevator car. |
| `floor.enter` | Answer to `floor.go` for a stub floor or the roof (`@roof`: no workers, no dog). |
| `pong` | Answer to `ping`, with the bridge's clock in `now`. |
| `peer.update` | Answer to `profile` (name, color, look). |
| `worker.update` | Every 4 s, for each working worker on the page's floor: its next `action` (and `activity`), which the worker acts out. |

## Page → server (handled)

| Message | What the stub does |
|---------|--------------------|
| `ping` | Answers `pong`. |
| `move` | Remembers where the page stands. |
| `floor.go` | Moves the page to that floor or the roof and answers `floor.enter`; unknown floors are ignored. |
| `sit` | Remembers the seat (cleared on `floor.go`). |
| `profile` | Answers `peer.update`. |

Every other `ClientMsg` is ignored, and every other `ServerMsg` is never sent: no terminals
(`screen`, `term.*`), no hiring or sending home, no GitHub (`gh.*`, the PR and issue windows show
an error), no chat broadcast, decor, dog, ball, cabinet, gong, darts, sky, theme or map changes.
The page's HTTP calls to agent-office's `/api/*` (search, model lists, docs, terminal drops,
GitHub details) are not served either: Vite answers them with its own 404 or index page.

What replaces the stub: M2 (#13) feeds the same messages from Orca's workspaces and
agents; M3 adds terminals and actions.

## Live mode (M2)

Without `ORCA_OFFICE_STUB`, `/client` gets the same messages from Orca (`bridge/src/live/`):

| Source | What it gives the office |
|--------|--------------------------|
| Plugin snapshot (`workspace.list`, every 10 s and on connect) | Floors (Orca projects) and desks (open worktrees, with a sign over the desk; an open worktree without agents is an empty desk). |
| `orca agent list --json` (every 5 s, and ~0.3 s after an event names an unknown agent) | Figures: one per agent session (terminal or chat), its state and its last message cut to a 120-char bubble (`toBubble`), never stored or logged. |
| `orca agent list --json --environment <name>` for each paired environment `hostScope` names | Remote agents on their repo's floor, tagged `🌐 <environment>`. |
| `orca bot list --json` (every 15 s) and the bots' chat agents | The Staff floor: one desk per bot, nameplate, `idle` / `working` / needs you. |
| Plugin `agent.status.changed` | State at once (de-duplicated; done after a 1 s debounce); an agent not listed yet sits down at once. |
| Plugin `agent.tool.after` (`action`, `failed` worked out in the worker) | `action` / `activity` on working terminal agents: read, edit, test, web, failing after 2 failed runs in a row. |

Mapping: floor = repository, desk = worktree (1–4 seats side by side in one cluster, `+N` on the sign past 4), figure = agent session. Messages: `welcome`, `floor.enter`, `floors`, `plan` (desk signs), `worker.update`, `worker.remove`, and `{ t: 'orca', online }` (the page shows "Orca offline" while the plugin isn't connected). The 2D list (`live.html`) connects with `?list=1` and still gets the plugin's messages, redacted.
