import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import { limitLevel, worstWindow } from '@orca-office/shared/office/protocol';
import { BACKOFF_MS, IDLE_MS, LimitsReader, MIN_GAP_MS, POLL_MS, claudeProbe, codexProbe, findCli, parseClaudeUsage, parseCodexUsage, probeEnv, type Reading } from './limits.js';
import { stubLimits } from '../stub.js';

// Made-up accounts and numbers only, shaped like Claude Code 2.1 and codex-cli 0.166 answers.

const fake = (name: string) => fileURLToPath(new URL(`../../fake/${name}.mjs`, import.meta.url));

afterEach(() => vi.useRealTimers());

test('Claude: the 5-hour session, the week and per-model weeks, and the plan; nothing else', () => {
  const r = parseClaudeUsage({
    session: { total_cost_usd: 0 },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12.5, resets_at: '2026-11-25T03:00:00+00:00' },
      seven_day: { utilization: 41, resets_at: '2026-11-30T16:00:00.126822+00:00', used_dollars: null },
      seven_day_opus: null,
      model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: '2026-11-30T16:00:00+00:00' }, { display_name: '  ', utilization: 5 }],
      extra_usage: { is_enabled: false },
    },
  });
  expect(r).toEqual({
    status: 'ok',
    plan: 'max',
    windows: [
      { label: '5h session', pct: 12.5, resetsAt: Date.parse('2026-11-25T03:00:00Z') },
      { label: 'Week', pct: 41, resetsAt: Date.parse('2026-11-30T16:00:00.126Z') },
      { label: 'Fable week', pct: 0, resetsAt: Date.parse('2026-11-30T16:00:00Z') },
    ],
  });
});

test('Claude: no 5-hour window yet, out-of-range numbers, older Claude Code, API key', () => {
  const r = parseClaudeUsage({ subscription_type: 'pro', rate_limits: { five_hour: null, seven_day: { utilization: 130 }, seven_day_opus: { utilization: -3 } } });
  expect(r.windows).toEqual([{ label: 'Week', pct: 100 }, { label: 'Opus week', pct: 0 }]);
  expect(parseClaudeUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null })).toEqual({ status: 'no-plan', windows: [] });
  expect(parseClaudeUsage(null).status).toBe('error');
});

const codexLimits = {
  rateLimits: { limitId: 'codex', primary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1796049266 }, secondary: null, credits: { hasCredits: false, balance: '0' }, planType: 'pro' },
  rateLimitsByLimitId: {
    codex: { limitId: 'codex' },
    codex_other: { limitId: 'codex_other', limitName: 'GPT-6 Mini', primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1796000000 } },
  },
  rateLimitResetCredits: { availableCount: 2, credits: [{ id: 'RateLimitResetCredit_x', title: 'Full reset' }] },
  accountId: 'not-passed-on',
};

test('Codex: windows by their length, other models’ pools by name, earned resets; no account id', () => {
  const r = parseCodexUsage({ account: { type: 'chatgpt', email: 'someone@example.com', planType: 'pro' } }, codexLimits);
  expect(r).toEqual({
    status: 'ok',
    plan: 'pro',
    resets: 2,
    windows: [
      { label: 'Week', pct: 3, resetsAt: 1796049266000 },
      { label: 'GPT-6 Mini 5h', pct: 50, resetsAt: 1796000000000 },
    ],
  });
  expect(JSON.stringify(r)).not.toMatch(/example\.com|not-passed-on|RateLimitResetCredit/);
});

test('Codex: session before week, unknown lengths keep primary/secondary, a seat’s monthly cap', () => {
  const both = parseCodexUsage({ account: { type: 'chatgpt' } }, { rateLimits: { primary: { usedPercent: 70, windowDurationMins: 10081 }, secondary: { usedPercent: 20, windowDurationMins: 299 } } });
  expect(both.windows.map((w) => w.label)).toEqual(['5h session', 'Week']);
  const legacy = parseCodexUsage({ account: { type: 'chatgpt' } }, { rateLimits: { primary: { usedPercent: 1 }, secondary: { usedPercent: 2 } } });
  expect(legacy.windows.map((w) => `${w.label} ${w.pct}`)).toEqual(['5h session 1', 'Week 2']);
  const seat = parseCodexUsage({ account: { type: 'chatgpt' } }, { rateLimits: { primary: null, individualLimit: { remainingPercent: 25, resetsAt: 1800000000 } } });
  expect(seat.windows).toEqual([{ label: 'Month', pct: 75, resetsAt: 1800000000000 }]);
});

test('Codex: not signed in, an API key, a failed read', () => {
  expect(parseCodexUsage({ account: null, requiresOpenaiAuth: true }, null)).toEqual({ status: 'signed-out', windows: [] });
  expect(parseCodexUsage({ account: { type: 'apiKey' } }, null)).toEqual({ status: 'no-plan', windows: [] });
  expect(parseCodexUsage({ account: { type: 'chatgpt', planType: 'plus' } }, null)).toEqual({ status: 'error', plan: 'plus', windows: [] });
});

test('the probes talk to the CLIs over stdio, without a shell, and settle on a hang or a missing binary', async () => {
  const env = probeEnv({ ...process.env, CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' });
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  const claude = await claudeProbe(fake('claude'), env)();
  expect(claude.status).toBe('ok');
  expect(claude.plan).toBe('max');
  expect(claude.windows.map((w) => w.label)).toEqual(['5h session', 'Week', 'Fable week']);
  const codex = await codexProbe(fake('codex'), env)();
  expect(codex).toMatchObject({ status: 'ok', plan: 'pro', resets: 2 });
  expect(codex.windows.map((w) => `${w.label} ${w.pct}`)).toEqual(['5h session 18', 'Week 83']);
  expect(await codexProbe(fake('codex'), { ...env, ORCA_OFFICE_FAKE_USAGE: 'signed-out' })()).toEqual({ status: 'signed-out', windows: [] });
  expect((await claudeProbe(fake('claude'), { ...env, ORCA_OFFICE_FAKE_USAGE: 'api-key' })()).status).toBe('no-plan');
  expect((await claudeProbe(fake('claude'), { ...env, ORCA_OFFICE_FAKE_USAGE: 'hang' }, 300)()).status).toBe('error');
  expect((await claudeProbe('/nonexistent/claude', env)()).status).toBe('missing');
});

test('a CLI is found by its ORCA_OFFICE_ variable, on PATH, or not at all', () => {
  expect(findCli('claude', { ORCA_OFFICE_CLAUDE: '/opt/x/claude' })).toBe('/opt/x/claude');
  expect(findCli('codex', { PATH: fileURLToPath(new URL('../../fake', import.meta.url)) }, [])).toBeNull();
  expect(findCli('codex.mjs', { PATH: fileURLToPath(new URL('../../fake', import.meta.url)) }, [])).toMatch(/fake\/codex\.mjs$/);
});

function reader(readings: Partial<Record<'claude' | 'codex', () => Reading>>, wanted = () => true) {
  const calls = { claude: 0, codex: 0 };
  const changed = vi.fn();
  const r = new LimitsReader({
    probes: {
      claude: readings.claude ? async () => (calls.claude++, readings.claude!()) : null,
      codex: readings.codex ? async () => (calls.codex++, readings.codex!()) : null,
    },
    wanted,
    changed,
  });
  return { r, calls, changed };
}

test('polls every 2 minutes while the office is open, and not while it is closed', async () => {
  vi.useFakeTimers();
  let open = false;
  const { r, calls, changed } = reader({ claude: () => ({ status: 'ok', windows: [{ label: 'Week', pct: 10 }] }) }, () => open);
  expect(r.state.providers.map((p) => `${p.id}:${p.status}`)).toEqual(['claude:loading', 'codex:missing']);
  r.start();
  await vi.advanceTimersByTimeAsync(POLL_MS * 3);
  expect(calls.claude).toBe(0);
  open = true;
  await vi.advanceTimersByTimeAsync(POLL_MS);
  expect(calls.claude).toBe(1);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(r.state.providers[0]).toMatchObject({ status: 'ok', name: 'Claude' });
  await vi.advanceTimersByTimeAsync(POLL_MS);
  expect(calls.claude).toBe(2);
  // A click right after a read waits for the gap; after it, it reads at once.
  r.refresh();
  await vi.advanceTimersByTimeAsync(10);
  expect(calls.claude).toBe(2);
  await vi.advanceTimersByTimeAsync(MIN_GAP_MS);
  r.refresh();
  await vi.advanceTimersByTimeAsync(10);
  expect(calls.claude).toBe(3);
  r.close();
});

test('backs off after failures, keeps the last numbers, and looks rarely at a CLI without a plan', async () => {
  vi.useFakeTimers();
  let fail = false;
  const { r, calls } = reader({
    claude: () => (fail ? { status: 'error', windows: [] } : { status: 'ok', windows: [{ label: 'Week', pct: 50 }] }),
    codex: () => ({ status: 'signed-out', windows: [] }),
  });
  r.start();
  await vi.advanceTimersByTimeAsync(10);
  expect(calls).toEqual({ claude: 1, codex: 1 });
  fail = true;
  await vi.advanceTimersByTimeAsync(POLL_MS * 3);
  expect(calls.claude).toBe(4);
  // Three failures in a row: the next read waits the backoff, and the week's numbers stay.
  expect(r.state.providers[0]).toMatchObject({ status: 'ok', windows: [{ pct: 50 }] });
  await vi.advanceTimersByTimeAsync(BACKOFF_MS - 1000);
  expect(calls.claude).toBe(4);
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls.claude).toBe(5);
  // Codex not signed in: once every half hour.
  expect(r.state.providers[1]?.status).toBe('signed-out');
  expect(calls.codex).toBe(1);
  await vi.advanceTimersByTimeAsync(IDLE_MS);
  expect(calls.codex).toBe(2);
  r.close();
});

test('the worst window across providers sets the meter, in Orca’s colours', () => {
  const l = stubLimits(0);
  expect(worstWindow(l)).toMatchObject({ provider: { id: 'codex' }, window: { label: 'Week', pct: 83 } });
  expect(worstWindow({ providers: [{ id: 'claude', name: 'Claude', status: 'no-plan', windows: [], at: 1 }], at: 1 })).toBeNull();
  expect([limitLevel(79), limitLevel(80), limitLevel(89.9), limitLevel(90)]).toEqual(['', 'near', 'near', 'over']);
});
