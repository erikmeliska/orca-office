import { expect, test } from 'vitest';
import { ALLOWED_CALLS, validParams } from './src/worker.js';

// What the bridge may make the worker do (design #14, #20): every allowed method has a shape check,
// and anything else is refused.

const T = 'term_0123abcd-ef';

test('only the light-control methods are allowed', () => {
  expect([...ALLOWED_CALLS].sort()).toEqual(['agents.list', 'terminal.focus', 'terminal.list', 'terminal.read', 'terminal.sendText', 'workspace.create', 'workspace.list', 'workspace.open']);
  for (const m of ['terminal.close', 'terminal.create', 'agent.launch', 'workspace.rename', 'automation.delete', 'commands.run']) expect(validParams(m, {})).toBe(false);
});

test('terminal calls take a term_ id and bounded text', () => {
  expect(validParams('terminal.read', { terminalId: T, maxLines: 400 })).toBe(true);
  expect(validParams('terminal.read', { terminalId: T, maxLines: 5000 })).toBe(false);
  expect(validParams('terminal.read', { terminalId: 'pty-1' })).toBe(false);
  expect(validParams('terminal.sendText', { terminalId: T, text: '\x1b[A\r' })).toBe(true);
  expect(validParams('terminal.sendText', { terminalId: T, text: 'x'.repeat(4097) })).toBe(false);
  expect(validParams('terminal.sendText', { terminalId: T, text: 'ls', enter: 'yes' })).toBe(false);
  expect(validParams('terminal.sendText', { terminalId: T, text: 'ls', extra: 1 })).toBe(false);
  expect(validParams('terminal.focus', { terminalId: T })).toBe(true);
  expect(validParams('terminal.focus', { terminalId: T, workspaceId: 'x' })).toBe(false);
});

test('workspace.open and workspace.create take only their own fields', () => {
  expect(validParams('workspace.open', { workspaceId: 'identity:wt2:local:abc' })).toBe(true);
  expect(validParams('workspace.open', { workspaceId: '' })).toBe(false);
  const ok = { projectId: 'p-1', agent: 'claude', prompt: 'Say hi' };
  expect(validParams('workspace.create', ok)).toBe(true);
  expect(validParams('workspace.create', { ...ok, name: 'try-it' })).toBe(true);
  expect(validParams('workspace.create', { ...ok, name: '../x' })).toBe(false);
  expect(validParams('workspace.create', { ...ok, agent: 'bash' })).toBe(false);
  expect(validParams('workspace.create', { ...ok, prompt: '  ' })).toBe(false);
  expect(validParams('workspace.create', { ...ok, prompt: 'x'.repeat(8001) })).toBe(false);
  expect(validParams('workspace.create', { ...ok, setup: 'skip' })).toBe(false);
  expect(validParams('workspace.create', { ...ok, open: true })).toBe(false);
});

test('reads keep their old shapes', () => {
  expect(validParams('workspace.list', { includeStatus: true })).toBe(true);
  expect(validParams('workspace.list', undefined)).toBe(true);
  expect(validParams('agents.list', { workspaceId: 'w' })).toBe(true);
  expect(validParams('agents.list', ['w'])).toBe(false);
});
