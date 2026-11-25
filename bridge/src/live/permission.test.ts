import { describe, expect, it } from 'vitest';
import { answerKey, menuOptions } from './permission.js';

// Made-up screens shaped like Claude Code's and Codex's permission prompts.
const CLAUDE = [
  '● Bash(rm -rf build)',
  '',
  '╭──────────────────────────────────────────────╮',
  '│ Bash command                                 │',
  '│   rm -rf build                               │',
  '│ Do you want to proceed?                      │',
  '│ ❯ 1. Yes                                     │',
  "│   2. Yes, and don't ask again for rm in /x   │",
  '│   3. No, and tell Claude what to do differently (esc) │',
  '╰──────────────────────────────────────────────╯',
];
const CODEX = [
  'Would you like to run the following command?',
  '  $ npm test',
  '› 1. Yes, proceed (y)',
  "  2. Yes, and don't ask again for this command (a)",
  '  3. No, and tell Codex what to do differently (esc)',
];

describe('permission prompts (M7 B1)', () => {
  it('Claude Code: digits, Escape for no', () => {
    expect(answerKey(CLAUDE, 'yes')).toEqual({ key: '1' });
    expect(answerKey(CLAUDE, 'always')).toEqual({ key: '2' });
    expect(answerKey(CLAUDE, 'no')).toEqual({ key: '\x1b' });
  });

  it("Codex: the options' own letters", () => {
    expect(answerKey(CODEX, 'yes')).toEqual({ key: 'y' });
    expect(answerKey(CODEX, 'always')).toEqual({ key: 'a' });
    expect(answerKey(CODEX, 'no')).toEqual({ key: '\x1b' });
  });

  it('nothing to answer when no menu is on the screen', () => {
    expect(answerKey(['> fix the tests', '✶ Thinking… (esc to interrupt)'], 'yes')).toEqual({ error: 'no_prompt' });
    // A numbered list in what the agent said is no prompt.
    expect(answerKey(['Plan:', '1. Read the code', '2. Fix it', '3. Test it'], 'yes')).toEqual({ error: 'no_prompt' });
  });

  it('a prompt without "always" says so', () => {
    expect(answerKey(['Do you want to make this edit?', '❯ 1. Yes', '  2. No (esc)'], 'always')).toEqual({ error: 'no_option' });
    expect(answerKey(['Do you want to make this edit?', '❯ 1. Yes', '  2. No (esc)'], 'yes')).toEqual({ key: '1' });
  });

  it('only the last menu on the screen counts', () => {
    const lines = ['1. Yes', '2. No', 'later…', ...CLAUDE];
    expect(menuOptions(lines).map((o) => o.n)).toEqual([1, 2, 3]);
    expect(answerKey(lines, 'always')).toEqual({ key: '2' });
  });
});
