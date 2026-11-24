# Usage and plan limits

The office shows how much of each provider's plan limits is used, the way Orca's status bar does.
This page records what Orca shows, where Orca reads it, and what the office reads, and how.
Orca was read at `stablyai/orca@9120306` (2026-11-24). Its rate limits are in
`src/main/rate-limits/` and the status bar in `src/renderer/src/components/status-bar/usage/`.

## What Orca shows

The status bar has one segment per provider. A click opens the provider's details: a bar for each
window with the percent used, the time to its reset (`in 2h 5m`, or a weekday and time further out)
and the plan's name. The colours follow consumption only: green, then yellow from 80 % used
(`USAGE_WARNING_PERCENT`), then red from 90 % (`USAGE_URGENT_PERCENT`). A provider that could not be
read shows why instead: `No subscription plan — API key billing`, `Sign in again to use this account.`,
`Claude usage is unavailable.` and so on.

Per provider (`ProviderRateLimits` in `src/shared/agent-usage/rate-limits/rate-limit-types.ts`):

| Provider | Windows Orca shows | Where Orca reads them |
|---|---|---|
| Claude | 5 h session, week (all models), Fable week (per-model), extra usage (pay-as-you-go balance) | OAuth token from Claude Code's Keychain item or credentials file → `api.anthropic.com/api/oauth/usage`. A live session's statusline reports fill gaps. |
| Codex | 5 h session, week, a workspace seat's monthly spend cap, credits, earned free resets, plan (`pro`, `plus`…) | `codex app-server` over JSON-RPC (`initialize`, then `account/rateLimits/read`), started in a hidden cwd (`~/Library/Application Support/orca/rate-limit-pty-cwd`). Fallback: `~/.codex/auth.json` tokens → the ChatGPT backend. |
| Antigravity (`agy`) | Named pools per model group, 5 h and weekly | `agy -p /usage --output-format json` |
| Muse | Subscription allowance | `muse usage --json` |
| Gemini | Per-model buckets | OAuth credentials file → `cloudcode-pa.googleapis.com` |
| Cursor | Plan pools, monthly | Session token from Keychain or Cursor's SQLite → cursor.com |
| Grok, Kimi, MiniMax, OpenCode Go, Z.ai Code | Session, week or month, depending on the provider | API keys or OAuth files → each vendor's HTTP API |

Orca polls in the background with backoff after failures and honours `Retry-After`.

## What the office reads

Only through the providers' own CLIs, which handle their sign-in themselves. The office never reads
a token, a Keychain item or an auth file, never signs in and never starts a conversation
(`bridge/src/live/limits.ts`):

| Provider | How | Cost |
|---|---|---|
| Claude | `claude -p --input-format stream-json --output-format stream-json … --setting-sources '' --no-session-persistence` and one `get_usage` control request. The answer has the numbers Claude Code's `/usage` screen shows: `rate_limits.five_hour`, `seven_day`, `model_scoped[]` (`display_name`, `utilization`, `resets_at`) and `subscription_type`. Taken from agent-office's `src/server/limits.ts` @ `852e2ab` (MIT, see NOTICE). | Nothing; ~1 s. |
| Codex | `codex -c approval_policy=never -c features.plugins=false app-server`, then `initialize`, `account/read` and, for a ChatGPT sign-in only, `account/rateLimits/read`: the same RPC Orca uses. Windows are classified by `windowDurationMins` (300 = 5 h, 10080 = week); other models' pools in `rateLimitsByLimitId` are shown under their `limitName`. | Nothing; no thread is started; ~0.7–2.5 s. |

The Codex rollout files in `~/.codex/sessions` also carry `rate_limits`, but only from the last time
Codex ran, and reading them means opening session files. The app-server answers with current numbers, so
the office uses the same path as Orca.

What leaves the bridge for the page: per provider its status, the plan's name, and for each window a
label, the percent used and the reset time; for Codex the number of earned free resets. No e-mail, no
account or organisation id, no credit ids. A CLI's stderr is dropped, and failures are logged once by
kind (`usage limits: codex read failed`).

Polling: each provider every 2 min while an office page is open (none while none is), at once when
someone walks in or clicks the meter (at most every 20 s), every 30 min for a CLI without plan limits
or sign-in, and every 10 min after three failed reads in a row. A failed read keeps the last numbers,
which say "As of …" once they are 10 min old. Each read is a child process without a shell, in the
temporary folder, killed after 30 s. The CLIs are found through `ORCA_OFFICE_CLAUDE` /
`ORCA_OFFICE_CODEX`, else on `PATH`, `~/.local/bin`, `/opt/homebrew/bin` or `/usr/local/bin`
(launchd's `PATH` is short).

States shown (`LimitsStatus` in `shared/src/office/protocol/usage.ts`):

| Status | Panel says |
|---|---|
| `ok` | the windows; `no window started yet` when there are none (e.g. no 5 h session open) |
| `loading` | `reading…` |
| `no-plan` | `API key, no plan limits` (Claude Code reports a sign-out the same way) |
| `signed-out` | `not signed in` (Codex) |
| `error` | `couldn’t read the limits` |
| `missing` | the provider is left out |

## What the office does not read, and why

- **Antigravity**: `agy -p /usage` works without a model turn, but a signed-out `agy` opens a browser
  to sign in (Orca holds its polls after that, #26484). A sign-in is something the office must not
  start, and it cannot tell whether `agy` is signed in without reading its keyring. Left out.
- **Muse**: not installed on the office's machine; `muse usage --json` would be safe to add.
- **Gemini, Cursor, Grok, Kimi, MiniMax, OpenCode Go, Z.ai Code**: Orca reads their tokens or API keys
  and calls the vendors' APIs itself. The office does not read credentials, so they are left out.
- **Claude extra usage, Codex credits**: not shown; neither account uses them.

## Tokens and cost today

Not shown yet. Neither CLI reports a day's tokens through these requests (`get_usage` has only the
probe's own session, which is empty). Orca counts them by scanning Claude Code's transcripts
(`~/.claude/projects`, several GB here) and Codex's rollout files; the office's own ledger (`Spend`
panel) is still empty on the live bridge.

## The office

- Top bar: `⏳ Codex ● 83%`: the window closest to its limit across the providers, with a dot in
  Orca's colours (green, amber from 80 %, red from 90 %). A phone shows only the dot and the number.
  `—` when nothing could be read. A click shows or hides the Usage panel.
- Usage panel (☰ → Show on screen → Usage): every provider with its plan, each window's percent,
  bar and time to reset, and Codex's free resets. A click reads again.
- `npm run dev:fake` runs stand-in CLIs (`bridge/fake/claude.mjs`, `bridge/fake/codex.mjs`);
  `ORCA_OFFICE_FAKE_USAGE=over,signed-out` (or `api-key`, `hang`) plays the other states. The stub
  (`npm run dev`) shows made-up limits too.
