#!/usr/bin/env node
// A stand-in `claude` (ORCA_OFFICE_CLAUDE) for `npm run dev:fake`: answers the `get_usage` control
// request with made-up plan limits (bridge/src/live/limits.ts). ORCA_OFFICE_FAKE_USAGE=api-key plays
// an API-key sign-in without plan limits; =hang never answers.
// Comma-separated, so one run can play both: ORCA_OFFICE_FAKE_USAGE=api-key,signed-out.
const modes = (process.env.ORCA_OFFICE_FAKE_USAGE ?? '').split(',');
const mode = (m) => modes.includes(m);
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
const h = 3_600_000;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    const msg = JSON.parse(line);
    if (msg.type !== 'control_request' || msg.request?.subtype !== 'get_usage' || mode('hang')) continue;
    const response =
      mode('api-key')
        ? { subscription_type: null, rate_limits_available: false, rate_limits: null }
        : {
            subscription_type: 'max',
            rate_limits_available: true,
            rate_limits: {
              five_hour: { utilization: 34, resets_at: iso(2.2 * h) },
              seven_day: { utilization: mode('over') ? 96 : 41, resets_at: iso(5.6 * 24 * h) },
              model_scoped: [{ display_name: 'Fable', utilization: 12, resets_at: iso(5.6 * 24 * h) }],
            },
          };
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
