# M5: messaging an Orca bot from outside (#36)

Checked on 2026-11-24 against Orca 1.4.272 on macOS, from a process with an empty environment
(`env -i HOME=… PATH=/usr/bin:/bin`), the way the bridge runs under launchd: no `ORCA_*`
variables, not an Orca terminal, not an agent session. One test message was sent, to ResearchBot,
in a new chat.

## The route

```sh
orca orchestration send --from orca-office --to bot:<name> --chat <id|new> \
  --type handoff --subject "<first line>" --body-file - --json   # body on stdin
```

| Step | Command | Shape |
|------|---------|-------|
| Bots | `orca bot list --json` | `bots[]`: `id`, `name`, `paused`, … |
| A bot's chats | `orca bot chats --bot <name> --json` | `chats[]`: `id`, `title`, `lastActivityAt`, `lastAsked`, `lastSaid`, `home`, `self`, `closed` |
| Send | `orca orchestration send …` (above) | `{ ok: true, result: { messageId, next } }`; no chat id, even with `--chat new` |
| Read the answer | `orca agent read <chat id> --json --limit 50` | the chat's conversation (same as the M3 chat panel) |

- **A chat's `id` is its `orcaSessionId`**: the id from `bot chats` goes straight to `agent read`
  and matches the chat agent in `orca agent list` (`workspace` = the bot's name).
- **`--from` is required** outside an agent. Without it the CLI refuses before anything is sent:
  `no_active_sender_terminal` ("Pass --from with your own terminal's handle … or run the command
  inside a live Orca terminal"). The host takes any handle; the office uses `orca-office`, which is
  nobody's terminal, so it can't read or consume another pane's mail.
- **`--chat new`** starts a chat titled from `--subject`; the result doesn't name it, so the new chat
  is the id that wasn't in `bot chats` before the send (here its first activity was 8 s after it).
- **Where the answer comes back**: in the bot's chat. Orca wraps the body in a header
  (`From: ORCA-OFFICE (orca-office) (question)`, subject, a `botRequest` payload and a
  `[Reply: orca orchestration reply --id <msg> …]` line). With `--type question` the bot tried
  that reply twice and got `terminal_not_found` (`orca-office` has no mailbox to wake), then said
  its answer in the chat anyway. No answer reached the inbox; it lists only the message itself
  (`from: orca-office`, `to: orca_session_id:<chat id>`).
- So the office sends **`--type handoff`**: per `send --help` the bot "takes it over", the turn is
  the bot's own and its answer stays in the chat, with no mail reply to attempt. The panel reads it
  with `agent read` and watches `state` (`working` while the turn runs). `--type handoff` itself was
  not sent to a real bot (one test message only); the fake CLI covers the panel.
- The body goes over **stdin** (`--body-file -`), not argv, so other local processes can't see the
  text in `ps`.

## What the office checks before it sends (bridge)

- The page is an authenticated `/client` (M3 token).
- The bot is one of `orca bot list` (by name, exact), not paused.
- The chat is `new` or one of that bot's open chats from `orca bot chats --bot <name>` (not
  `closed`, not `self`).
- The text is 1–`ORCA_LIMITS.prompt` (8000) characters, without NUL.
- Rate limit for the whole bridge (all pages): 1 message every 5 s, 200 an hour.
- `execFile` with an argument array (never a shell); the subject is the text's first line cut to
  60 characters, passed as `--subject=<…>` so it can't read as a flag.
- No message or answer text is logged, stored, put in tests or screenshots; errors carry a code.

## Not available from outside

- No per-message delivery or read receipt for a bot chat; "the bot is working" comes from the
  chat's `state` (`agent read`) and `orca agent list`.
- `orca agent send` / typing into a chat agent: Orca has no API for writing to a regular (non-bot)
  chat; out of scope for M5.
