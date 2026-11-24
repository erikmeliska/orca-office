# orca-office

A 3D cartoon office on top of [Orca](https://orca.dev): every worktree is a desk, every agent session a figure, and you can see at a glance who is working, who needs you and who is done.

Status: planning. See [docs/design.md](docs/design.md) and the milestone epics in Issues.

The 3D client is derived from [AgentSystemLabs/agent-office](https://github.com/AgentSystemLabs/agent-office) (MIT).

## Layout

| Folder    | What                                                                 |
|-----------|----------------------------------------------------------------------|
| `shared/` | Wire protocol and helpers used by the bridge, client and plugin      |
| `bridge/` | Local Node process on `127.0.0.1` between Orca and the browser       |
| `client/` | 3D office in the browser (Vite + three.js, from M1)                  |
| `plugin/` | Orca `trusted-worker` plugin; loaded by Orca as is, not an npm workspace |

## Develop

Node 24 (`.nvmrc`).

```sh
npm install
npm run typecheck && npm run lint && npm test && npm run build
npm run dev:bridge   # http://127.0.0.1:4317/health
npm run dev:client   # http://127.0.0.1:5317
```
