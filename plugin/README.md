# plugin: orca-office feed

Orca `trusted-worker` plugin that connects to the bridge on
`ws://127.0.0.1:4317/plugin`, sends a snapshot of workspaces and agents, then
pushes `agent.status.changed`, `workspace.*` events and `agent.tool.after`
hooks (tool name and input keys only). The bridge can call an allowlisted set
of host methods back through it (`terminal.read`, `terminal.sendText`, …).

Orca loads the files as they are (no build step) and refuses imports outside
this folder, so nothing here comes from `../shared`.

```sh
orca plugin types plugin        # writes .orca/types (git-ignored)
npm run typecheck:plugin
orca plugin dev load plugin --json                    # shows what it asks for
orca plugin dev load plugin --approve <fingerprint>   # after reading it
orca plugin logs local.office-feed
```

The "Office" status bar item shows whether the bridge is connected; clicking it
reconnects. Declaring it also keeps the worker running while the plugin is
enabled.
