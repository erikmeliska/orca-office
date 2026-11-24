// What workers spend: session usage, the office ledger and the providers' plan limits.

/** Session usage. The persistent office ledger continues to cover Claude Code only. */
export interface Usage {
  /** Input tokens that missed the prompt cache. */
  input: number;
  output: number;
  /** Reasoning tokens reported separately from output, when available. */
  reasoning?: number;
  /** False when the provider supplies tokens without usable pricing. Omitted for legacy Claude usage. */
  costKnown?: boolean;
  /** Provider history is still loading, failed to load, or reached a traversal limit. */
  incomplete?: boolean;
  /** Tokens written to the prompt cache. */
  cacheWrite: number;
  /** Tokens read from the prompt cache. */
  cacheRead: number;
  /** USD: estimated from the office's price list while a session runs, Claude Code's own figure once it has ended. */
  cost: number;
  /** API calls (assistant messages) counted. */
  calls: number;
  /** False when the provider reports cumulative tokens without a reliable call count. */
  callsKnown?: boolean;
  /** Authoritative provider total when it cannot be reconstructed from the displayed buckets. */
  totalTokens?: number;
  /** Size of the context window in tokens, when the provider reports one (DeepSeek Harness over ACP). */
  contextSize?: number;
  /**
   * The model its latest call ran on, as its session names it (`claude-opus-5-5`), when the office
   * reads that off the session: what a worker's card says it runs, whatever was asked for.
   */
  model?: string;
}

/** Every token a session used, cache reads and writes included: what the office shows. */
export function tokensOf(u: Usage): number {
  return u.totalTokens ?? u.input + u.output + (u.reasoning ?? 0) + u.cacheWrite + u.cacheRead;
}

/** e.g. 950, 12k, 1.25M */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 10e6 ? 2 : 1)}M`;
}

export function fmtCost(usd: number): string {
  if (usd > 0 && usd < 0.005) return '<$0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Spend across the whole office, kept on disk (see server/usage.ts). */
export interface UsageState {
  /** Every worker the office ever ran, including ones sent home. */
  total: Usage;
  /** Since midnight on the office's machine. */
  today: Usage;
  /** The day `today` covers, YYYY-MM-DD on the office's machine. */
  day: string;
  /** Daily budget in USD (--budget), when one is set. */
  budget?: number;
  /** New hires are refused for the rest of the day once the budget is spent (--budget-pause). */
  pauseHiring: boolean;
}

/** One usage window of a provider's plan: the 5-hour session, the week, or a model's week. */
export interface PlanWindow {
  /** e.g. "5h session", "Week", "Fable week". */
  label: string;
  /** Percent of the window used, 0-100. */
  pct: number;
  /** When it starts over (ms since epoch), when known. */
  resetsAt?: number;
}

/** The providers whose plan limits the office reads, the way Orca's status bar shows them (docs/usage.md). */
export type LimitsProviderId = 'claude' | 'codex';

/**
 * Why a provider shows windows or not:
 * - `ok`: read; `windows` may still be empty when no window has started;
 * - `loading`: not read yet;
 * - `no-plan`: signed in with an API key (or Bedrock, Vertex), which has no plan limits;
 * - `signed-out`: the CLI is not signed in (the office never signs in for it);
 * - `missing`: the CLI is not installed on the office's machine;
 * - `error`: the last read failed (timeout, no network, a CLI too old to answer).
 */
export type LimitsStatus = 'ok' | 'loading' | 'no-plan' | 'signed-out' | 'missing' | 'error';

/** One provider's plan limits: numbers and the plan's name only, never the account. */
export interface ProviderLimits {
  id: LimitsProviderId;
  /** "Claude", "Codex". */
  name: string;
  status: LimitsStatus;
  /** 'max', 'pro', 'plus', 'team'…, when known. */
  plan?: string;
  /** The 5-hour session first, then the week, then per-model weeks. */
  windows: PlanWindow[];
  /** Codex: free rate-limit resets the account has earned and not used yet. */
  resets?: number;
  /** When the numbers were read (ms since epoch); 0 before the first read. */
  at: number;
}

/**
 * The plan limits of the accounts the office's workers run on, per provider, as Orca's usage view
 * shows them (bridge/src/live/limits.ts). One account per provider for the whole building.
 */
export interface PlanLimits {
  providers: ProviderLimits[];
  /** When any provider was last read (ms since epoch); 0 before the first read. */
  at: number;
}

/** The window closest to its limit across every provider that was read, or null when none was. */
export function worstWindow(l: PlanLimits): { provider: ProviderLimits; window: PlanWindow } | null {
  let best: { provider: ProviderLimits; window: PlanWindow } | null = null;
  for (const p of l.providers) {
    if (p.status !== 'ok') continue;
    for (const w of p.windows) if (!best || w.pct > best.window.pct) best = { provider: p, window: w };
  }
  return best;
}

/** Orca's colours: 80% used turns the meter amber, 90% red. */
export function limitLevel(pct: number): 'over' | 'near' | '' {
  return pct >= 90 ? 'over' : pct >= 80 ? 'near' : '';
}

export type UsageClientMsg =
  /** Read the plan limits again now, instead of at the next poll. */
  | { t: 'limits.refresh' };

export type UsageServerMsg =
  | { t: 'usage'; state: UsageState }
  | { t: 'limits'; state: PlanLimits };
