import { expect, test } from 'vitest';
import { commandAction as sharedCommand, outputFailed as sharedFailed, toolAction as sharedTool } from '@orca-office/shared/office/actions';
import { commandAction, outputFailed, toolAction } from './src/worker.js';

// The plugin can't import ../shared, so it carries a copy of the tool → action rules: same answers.

const TOOLS: [string, unknown][] = [
  ['Read', {}],
  ['Edit', {}],
  ['MultiEdit', {}],
  ['WebFetch', {}],
  ['mcp__fetch__fetch', {}],
  ['mcp__linear__list', {}],
  ['Task', {}],
  ['Bash', { command: 'npm test' }],
  ['Bash', { command: 'cd web && npx vitest run' }],
  ['Bash', { command: 'git log --oneline' }],
  ['Bash', { command: 'rm -rf dist' }],
  ['exec_command', { command: 'cargo test' }],
];

test('tool actions match shared/src/office/actions.ts', () => {
  for (const [tool, input] of TOOLS) expect([tool, toolAction(tool, input)]).toEqual([tool, sharedTool(tool, input)]);
  for (const c of ['FOO=1 pnpm run build:web', 'sed -n 1,20p a.ts', 'python3 -m pytest -q', 'echo hi'])
    expect([c, commandAction(c)]).toEqual([c, sharedCommand(c)]);
});

test('failed runs: exit code first, else the summary lines', () => {
  const vitestFail = ' Test Files  1 failed | 3 passed (4)\n';
  expect(outputFailed(vitestFail)).toBe(sharedFailed(vitestFail));
  expect(outputFailed({ stdout: vitestFail })).toBe(true);
  expect(outputFailed({ stdout: 'all good', exitCode: 1 })).toBe(true);
  expect(outputFailed({ stdout: vitestFail, exitCode: 0 })).toBe(false);
  expect(outputFailed(undefined)).toBe(false);
});
