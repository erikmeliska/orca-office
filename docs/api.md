# Office API (v1)

The bridge's read-only API for **local processes**: everything the bridge knows about Orca (floors,
worktrees, agents, bots, Runs, plan limits, project rooms) as one JSON snapshot, and a stream of
change notices, so a consumer doesn't have to poll the Orca CLI itself. The first consumer is
Maestro (a Next.js app on `127.0.0.1:4300`, reading the API from its server side).

- Types: [`shared/src/office/api.ts`](../shared/src/office/api.ts) (the contract; copy it or generate from it)
- Server: [`bridge/src/api/`](../bridge/src/api/) (`server.ts` routes and auth, `snapshot.ts` the snapshot,
  `private-texts.ts` the full texts)
- Example client: [`scripts/office-api-example.mjs`](../scripts/office-api-example.mjs)

## Endpoints

On the bridge's port (`ORCA_OFFICE_PORT`, default 4317), `http://127.0.0.1:<port>`:

| | Token | What |
|---|---|---|
| `GET /api/v1/health` | no | `{ ok: true, version: 1, orca: { connected } }`; nothing private |
| `GET /api/v1/snapshot` | yes | `ApiSnapshot`, below |
| `GET /api/v1/events` | yes | Server-Sent Events: `snapshot`, `changed`, `heartbeat` |

`HEAD` works too; anything else is `405`. Responses are `Cache-Control: no-store`.

### Snapshot

```jsonc
{
  "version": 1,               // the contract's version; v2 gets new paths
  "at": 1795615280512,        // when it was made (ms)
  "rev": 12,                  // bumped whenever the content changes
  "fingerprint": "F5-liwx…",  // digest of the content: equal digests, equal content
  "orca": { "connected": true, "lastSnapshotAt": 1795615277613 },
  "floors":    [ /* ApiFloor: id, projectId, name, dir (main checkout), needsYou, working, stuck, done */ ],
  "worktrees": [ /* ApiWorktree: id, orcaWorktreeId, floorId, name, branch, path, hostId, open,
                    workspaceStatus (Kanban), unread, comment, links (PR/MR/issue), servers (orca ports) */ ],
  "agents":    [ /* ApiAgent: id, worktreeId, floorId, agent, surface terminal|chat, state, needsYou,
                    asks, stuck, since, title, question, bubble, lastAction, orcaSessionId, sessionId,
                    paneKey, terminalId, hostId */ ],
  "bots":      [ /* ApiBot: id, name, state, chats [{ id, state, lastActivityAt }] */ ],
  "runs":      [ /* ApiRun: id, objective, live, tasks, gates (pending), workers, coordinator */ ],
  "usage":     { /* plan limits per provider (#70), as the Usage panel shows them; null in stub mode */ },
  "rooms":     [ /* ApiRoom: project rooms on the roof (a live Run or a worktree family) */ ]
}
```

Every field is documented in `api.ts`. Notes:

- **Ids.** A floor's id is the office's (`f-…`, stable across renames for an Orca project). A worktree's
  `id` is Orca's workspace id (what `agents[].worktreeId` points at); `orcaWorktreeId` is the
  `<repoId>::<path>` form the CLI and orchestration use. An agent's `id` (`a-…`) is the office's figure
  id, stable for the session.
- **State.** `state` is Orca's (`working`, `blocked` = asks a permission, `waiting` = asks a question,
  `done`), with done held back ~1 s as in the office. `needsYou` = blocked or waiting.
  `stuck` is the office's guess: working, and Orca quiet about it ≥15 min or working ≥4 h at a
  stretch (`stuckWhy`: `quiet` | `long`).
- **`question`** is the agent's last words in full as Orca gives them (`lastAssistantMessage`, up to
  ~200 characters), only while it needs you; `bubble` is the one-line ≤120-character cut the office shows.
- **`servers`** and **`usage`** are read while someone looks: an office page or an open event stream.
  A consumer that only fetches snapshots sees them only while one of those is open.
- Within v1 fields may be added; none is removed or changes meaning.

### Events

`GET /api/v1/events` is a standard `text/event-stream`:

```
retry: 3000

event: snapshot
id: 12
data: {"version":1,"at":…,"rev":12,…the full snapshot…}

event: changed
id: 13
data: {"rev":13,"fingerprint":"2IrC9n…","at":1795615283158}

event: heartbeat
data: {"rev":13,"at":1795615295513}
```

- `snapshot` once, right after connecting.
- `changed` when the content changed (at most once a second): it carries the new `rev`, never content.
  A client whose `rev` is older fetches `/api/v1/snapshot`.
- `heartbeat` every ~15 s, with the current `rev`. A client that hears nothing for ~45 s reconnects.
- At most 8 streams at a time (`503 busy` past that). On reconnect you get a fresh `snapshot`.

The lastSnapshotAt time alone is not a change (it moves every ~10 s). A working agent's hooks change
`lastAction` and `quietSince` often, so expect `changed` about once a second while agents work.

## Authentication and privacy

The API is for processes on this machine, not for browsers (design #20):

- The bridge listens on `127.0.0.1` only. `Host` must be `127.0.0.1:<port>` or `localhost:<port>`,
  else **421** (DNS rebinding).
- A request with an **`Origin`** header is refused, **403**, token or not. Browsers send `Origin` on
  every cross-origin request and on page `fetch`es, so no web page (another site, the office page
  itself, a page on another local port) can use the API. Node's `fetch` and curl send none.
- `/snapshot` and `/events` need **`Authorization: Bearer <token>`**, else **401**. The token is the
  *consumer* token in `~/.orca-office/api-token` (64 hex characters, file 0600 in a 0700 folder),
  made by the bridge on first start. It is separate from the plugin's HMAC key (`token`) and the office
  page's token (`client-token`): a leaked consumer token lets no one pose as the plugin or open the
  office page's socket, and the API can do nothing but read. Compared in constant time.
  To rotate it, delete the file and restart the bridge.
- Rate limits: 60 requests at once, then 10 a second; 10 failed tokens, then one a second; **429**.

**Private text.** The office treats agents' words, session titles, Run objectives, task titles, gate
questions and worktree comments as private (`shared/src/privacy.ts`). The office page in the browser
still gets only the short cuts (`toBubble`). This API is the one exception: it gives them **in full**
(`agents[].question`, `agents[].title`, `runs[].objective`, `runs[].tasks[].title`,
`runs[].gates[].question/options`, `rooms[].name`, `worktrees[].comment`) to an authenticated local
process. The bridge keeps them in memory only (`bridge/src/api/private-texts.ts`), replaced on every
read; they are never logged, written to disk or put in an error. A consumer takes on the same duty:
don't log, store or send them on. What this protects against, and what not: as with the page's token,
it keeps out browsers and other accounts that can't read your home folder; a program running as you
can read the token file anyway.

## Examples

```sh
TOKEN=$(cat ~/.orca-office/api-token)

curl -s http://127.0.0.1:4317/api/v1/health
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4317/api/v1/snapshot | jq '.agents[] | select(.needsYou) | {worktreeId, asks, question}'
curl -sN -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4317/api/v1/events
```

A Node client that prints who waits for you (once, or with `--watch` on every change):

```sh
node scripts/office-api-example.mjs
node scripts/office-api-example.mjs --watch
ORCA_OFFICE_PORT=4457 node scripts/office-api-example.mjs   # another bridge
```

Its core, without dependencies (Node 22+):

```js
const token = readFileSync(join(homedir(), '.orca-office', 'api-token'), 'utf8').trim();
const res = await fetch('http://127.0.0.1:4317/api/v1/snapshot', { headers: { authorization: `Bearer ${token}` } });
const snap = await res.json();
for (const a of snap.agents.filter((a) => a.needsYou)) console.log(a.worktreeId, a.asks, a.question);
```

From a Next.js app, call it from server code (a route handler or a server component), never from the
browser: the browser would send an `Origin` and must not see the token.

## Trying it without Orca

`ORCA_OFFICE_PORT=4457 ORCA_OFFICE_CLIENT_PORT=5457 npm run dev:fake` runs a bridge on made-up data
(`bridge/fake/`); the API is then on `http://127.0.0.1:4457/api/v1/…` with the same token file.

## v2: actions (not implemented)

v1 only reads. Actions would come as `POST` under `/api/v2/` with the same authentication, a JSON body,
their own rate limits (as the page's in `bridge/src/rate.ts`) and a result `{ ok, error? }`; each
reuses what the office page can already do (`bridge/src/live/actions.ts`), nothing new in Orca:

| Action | Would be | Through |
|---|---|---|
| Open in Orca | `POST /api/v2/agents/:id/open` | the plugin (`workspace.open`, `terminal.focus`), as the page's "Open in Orca" |
| Answer | `POST /api/v2/agents/:id/answer` `{ text }` (or `{ choice }` for a permission) | `orca terminal send` / the chat, as the page's answer box |
| Mark read | `POST /api/v2/worktrees/:id/read` | `orca worktree set --read` |
| Comment | `POST /api/v2/worktrees/:id/comment` `{ comment }` | `orca worktree set --comment=` |
| Decide a gate | `POST /api/v2/runs/:run/gates/:gate` `{ option }` | Orca's gate CLI (the office doesn't decide gates yet) |

Answering types into an agent, so v2 would need a token that says it may act (a separate
`api-actions-token`, or a scope in the token file), and Erik's go.
