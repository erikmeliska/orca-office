/**
 * Answering a permission prompt from the banner (M7, roadmap B1). The page never sends keys: it says
 * "yes", "always" or "no", and the bridge reads the agent's terminal, finds the menu on the screen and
 * sends the one key that picks that option. No menu on the screen, nothing is typed.
 *
 * What the menus look like (the last lines of `terminal.read`):
 *
 *   Claude Code                                    Codex
 *   Do you want to proceed?                        Would you like to run the following command?
 *   ❯ 1. Yes                                       › 1. Yes, proceed (y)
 *     2. Yes, and don't ask again for … in /x        2. Yes, and don't ask again for this command (a)
 *     3. No, and tell Claude what to do …  (esc)     3. No, and tell Codex what to do differently (esc)
 *
 * Both take the option's digit, and Codex also the letter in brackets. A trailing "(esc)" is Escape.
 * Claude Code answers a digit at once (no Enter), as does Codex; the bridge sends the option's own
 * shortcut when it has one, else its digit.
 *
 * The screen text is used for this one decision and dropped: never stored or logged.
 */
import type { OrcaAnswer } from '@orca-office/shared/office/protocol/orca';

/** Lines from the end of the screen a menu is looked for in. */
export const MENU_LINES = 30;

export interface MenuOption {
  n: number;
  label: string;
  /** Its own key: a letter, or Escape. */
  shortcut: string | null;
}

/** The numbered options of the last menu on the screen ("1. Yes", "› 2. …"); [] when there is none. */
export function menuOptions(lines: readonly string[]): MenuOption[] {
  const tail = lines.slice(-MENU_LINES);
  let opts: MenuOption[] = [];
  for (const raw of tail) {
    // Box-drawing borders round the menu, and the cursor (❯ › > ▸) in front of the chosen one.
    const line = raw.replace(/[│┃║]/g, ' ').trim();
    const m = /^(?:[❯›>▸»*]\s*)?(\d)[.)]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    // A new list starts at 1: only the last one on the screen counts.
    if (n === 1) opts = [];
    if (n !== opts.length + 1) continue;
    const label = m[2]!;
    const sc = /\((esc|[a-z])\)\s*$/i.exec(label);
    opts.push({ n, label, shortcut: sc ? (sc[1]!.toLowerCase() === 'esc' ? '\x1b' : sc[1]!.toLowerCase()) : null });
  }
  return opts.length >= 2 ? opts : [];
}

const ALWAYS = /don'?t ask again|always|for (?:this|the) session|for the rest|allow all|remember/i;

/** Which option of a permission menu `choice` is: yes (once), always (yes, don't ask again), no. */
export function pickOption(opts: readonly MenuOption[], choice: OrcaAnswer): MenuOption | null {
  const yes = opts.filter((o) => /^(?:yes|allow|approve|proceed)\b/i.test(o.label));
  const no = opts.filter((o) => /^(?:no|deny|reject|cancel)\b/i.test(o.label));
  // A menu without both a yes and a no isn't a permission prompt.
  if (!yes.length || !no.length) return null;
  if (choice === 'no') return no[0]!;
  if (choice === 'always') return yes.find((o) => ALWAYS.test(o.label)) ?? null;
  return yes.find((o) => !ALWAYS.test(o.label)) ?? null;
}

/**
 * The key that answers the permission prompt on `lines` with `choice`, or why not:
 * `no_prompt` (no permission menu on the screen), `no_option` (it has no such answer, e.g. no "always").
 */
export function answerKey(lines: readonly string[], choice: OrcaAnswer): { key: string } | { error: 'no_prompt' | 'no_option' } {
  const opts = menuOptions(lines);
  if (!opts.length) return { error: 'no_prompt' };
  const yes = opts.some((o) => /^(?:yes|allow|approve|proceed)\b/i.test(o.label));
  const no = opts.some((o) => /^(?:no|deny|reject|cancel)\b/i.test(o.label));
  if (!yes || !no) return { error: 'no_prompt' };
  const o = pickOption(opts, choice);
  if (!o) return { error: 'no_option' };
  return { key: o.shortcut ?? String(o.n) };
}
