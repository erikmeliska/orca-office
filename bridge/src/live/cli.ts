/**
 * The bridge's polling of the Orca CLI (design #18, #29; issues #19, #20, #21): `orca agent list
 * --json` every ~5 s for this host and, with `--environment <name>`, for each paired environment it
 * names; `orca bot list --json` every ~15 s. 0.1–0.7 s a call (spike-m0.md).
 *
 * Nothing the CLI prints is kept, written or logged: it is parsed (orca.ts cuts agent text to a
 * bubble right there) and handed to the model; errors are logged by kind only.
 */
import { execFile } from 'node:child_process';
import { parseAgentList, parseBots, parseTerminals, type CliAgentList, type CliTerminal, type OrcaBot } from './orca.js';
import { parseWorktreeList, type OrcaWorktree } from './worktrees.js';

export const AGENTS_EVERY_MS = 5_000;
export const BOTS_EVERY_MS = 15_000;
/** `orca worktree list --json` (links, lineage): every 30 s, and soon after a `workspace.*` event. */
export const WORKTREES_EVERY_MS = 30_000;
const WORKTREES_KICK_MS = 1_500;
const WORKTREES_MIN_GAP_MS = 5_000;
/** The quickest a refresh asked for by an event (a new agent) follows the last one. */
const KICK_AFTER_MS = 300;

export type RunJson = (args: string[]) => Promise<unknown>;

/** Runs `orca <args>` and parses its JSON; rejects with a short reason, never the output. */
export function orcaCli(bin = process.env.ORCA_BIN || 'orca', timeoutMs = 8_000): RunJson {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: process.env }, (err, stdout) => {
        if (err) return reject(new Error(`orca ${args[0]} ${args[1]} failed (${(err as NodeJS.ErrnoException).code ?? 'exit'})`));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`orca ${args[0]} ${args[1]}: not JSON`));
        }
      });
    });
}

export interface PollSink {
  agents(hostId: string, list: CliAgentList): void;
  bots(bots: OrcaBot[]): void;
  /** This machine's terminal handles by pane (`orca terminal list`), for the office's live terminal. */
  terminals?(list: CliTerminal[]): void;
  /** `orca worktree list --json` on this machine: links and lineage (#32). */
  worktrees?(list: OrcaWorktree[]): void;
  /** A poll failed (Orca not running, CLI missing): the kind of failure only. */
  error(what: string): void;
}

export class CliPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private botsTimer: ReturnType<typeof setInterval> | null = null;
  private worktreesTimer: ReturnType<typeof setTimeout> | null = null;
  private worktreesRunning = false;
  private worktreesKicked = false;
  private worktreesAt = 0;
  private running = false;
  private again = false;
  private lastRun = 0;
  private environments: { hostId: string; name: string }[] = [];

  constructor(
    private run: RunJson,
    private sink: PollSink,
    private everyMs = AGENTS_EVERY_MS,
  ) {}

  start(): void {
    void this.poll();
    void this.pollBots();
    this.botsTimer = setInterval(() => void this.pollBots(), BOTS_EVERY_MS);
    if (this.sink.worktrees) void this.pollWorktrees();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.botsTimer) clearInterval(this.botsTimer);
    if (this.worktreesTimer) clearTimeout(this.worktreesTimer);
    this.timer = this.botsTimer = this.worktreesTimer = null;
  }

  /** A workspace came or went: read the worktrees' links again soon (once, however many events). */
  kickWorktrees(): void {
    if (!this.sink.worktrees || this.worktreesKicked) return;
    this.worktreesKicked = true;
    if (this.worktreesTimer) clearTimeout(this.worktreesTimer);
    // Never sooner than WORKTREES_KICK_MS after the last read, however many events come.
    const wait = Math.max(WORKTREES_KICK_MS, this.worktreesAt + WORKTREES_MIN_GAP_MS - Date.now());
    this.worktreesTimer = setTimeout(() => void this.pollWorktrees(), wait);
  }

  async pollWorktrees(): Promise<void> {
    if (!this.sink.worktrees || this.worktreesRunning) return;
    this.worktreesRunning = true;
    this.worktreesKicked = false;
    this.worktreesAt = Date.now();
    if (this.worktreesTimer) clearTimeout(this.worktreesTimer);
    try {
      this.sink.worktrees(parseWorktreeList(await this.run(['worktree', 'list', '--json'])));
    } catch (err) {
      this.sink.error((err as Error).message);
    }
    this.worktreesRunning = false;
    this.worktreesTimer = setTimeout(() => void this.pollWorktrees(), WORKTREES_EVERY_MS);
  }

  /** Poll again soon: an event named an agent the model doesn't know yet. */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), Math.max(0, this.lastRun + KICK_AFTER_MS - Date.now()));
  }

  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.lastRun = Date.now();
    if (this.timer) clearTimeout(this.timer);
    try {
      const local = parseAgentList(await this.run(['agent', 'list', '--json']));
      this.sink.agents('local', local);
      this.environments = local.environments;
    } catch (err) {
      this.sink.error((err as Error).message);
    }
    if (this.sink.terminals) {
      try {
        this.sink.terminals(parseTerminals(await this.run(['terminal', 'list', '--json'])));
      } catch (err) {
        this.sink.error((err as Error).message);
      }
    }
    for (const env of this.environments) {
      try {
        // Under the environment's name (its host tag in the office), so each list replaces only its own agents.
        const list = parseAgentList(await this.run(['agent', 'list', '--json', '--environment', env.name]), env.name);
        this.sink.agents(env.name, { ...list, agents: list.agents.map((a) => ({ ...a, hostId: env.name })) });
      } catch (err) {
        this.sink.error((err as Error).message);
      }
    }
    this.running = false;
    const soon = this.again;
    this.again = false;
    this.timer = setTimeout(() => void this.poll(), soon ? KICK_AFTER_MS : this.everyMs);
  }

  async pollBots(): Promise<void> {
    try {
      this.sink.bots(parseBots(await this.run(['bot', 'list', '--json'])));
    } catch (err) {
      this.sink.error((err as Error).message);
    }
  }
}

/**
 * Types into a terminal through the CLI (see ActionDeps.send): one argument per value, never a
 * shell; the text is never logged, and a failure says only its kind.
 */
export function orcaSend(bin = process.env.ORCA_BIN || 'orca', timeoutMs = 8_000) {
  return (terminalId: string, text: string, enter: boolean): Promise<true | string> =>
    new Promise((resolve) => {
      if (!/^term_[A-Za-z0-9_-]{1,120}$/.test(terminalId)) return resolve('invalid');
      const args = ['terminal', 'send', '--terminal', terminalId, `--text=${text}`, ...(enter ? ['--enter'] : []), '--json'];
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: process.env }, (err, stdout) => {
        if (err) return resolve('cli_failed');
        try {
          const r = JSON.parse(stdout) as { ok?: boolean; result?: { send?: { accepted?: boolean } } };
          resolve(r.ok !== false && r.result?.send?.accepted !== false ? true : 'not_accepted');
        } catch {
          resolve('cli_failed');
        }
      });
    });
}
