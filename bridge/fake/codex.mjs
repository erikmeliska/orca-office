#!/usr/bin/env node
// A stand-in `codex` (ORCA_OFFICE_CODEX) for `npm run dev:fake`: a `codex app-server` that answers
// `account/read` and `account/rateLimits/read` with made-up numbers (bridge/src/live/limits.ts).
// ORCA_OFFICE_FAKE_USAGE=signed-out plays a Codex that isn't signed in.
// Comma-separated, so one run can play both: ORCA_OFFICE_FAKE_USAGE=api-key,signed-out.
const modes = (process.env.ORCA_OFFICE_FAKE_USAGE ?? '').split(',');
const mode = (m) => modes.includes(m);
const now = Math.floor(Date.now() / 1000);
const h = 3600;
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (msg.method === 'initialize') reply(msg.id, { userAgent: 'fake-codex' });
    else if (msg.method === 'account/read')
      reply(msg.id, { account: mode('signed-out') ? null : { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true });
    else if (msg.method === 'account/rateLimits/read') {
      const main = {
        limitId: 'codex',
        limitName: null,
        primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: now + 3.1 * h },
        secondary: { usedPercent: 83, windowDurationMins: 10080, resetsAt: now + 2.4 * 24 * h },
        planType: 'pro',
      };
      reply(msg.id, { rateLimits: main, rateLimitsByLimitId: { codex: main }, rateLimitResetCredits: { availableCount: 2 } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
