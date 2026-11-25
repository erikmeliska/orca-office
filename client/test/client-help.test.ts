import { test } from 'vitest';
import assert from 'node:assert/strict';
import { HELP_ROWS as REST, SUPERVISE_ROWS } from '../src/ui/help.js';

const HELP_ROWS = [...SUPERVISE_ROWS, ...REST];

test('every row of the controls help has a key and what it does, and no key is listed twice', () => {
  for (const [key, text] of HELP_ROWS) {
    assert.ok(key.trim(), `a row with no key: ${text}`);
    assert.ok(text.trim(), `${key} says nothing`);
  }
  const keys = HELP_ROWS.map(([k]) => k);
  assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), []);
});

test('the help starts with what you need to look after the agents, six or so rows (M6 A10)', () => {
  assert.ok(SUPERVISE_ROWS.length <= 7);
  assert.deepEqual(SUPERVISE_ROWS.map(([k]) => k).filter((k) => ['N', 'E', 'O', 'R', 'M'].includes(k)), ['N', 'E', 'O', 'R', 'M']);
});
