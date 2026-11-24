import { test } from 'vitest';
import assert from 'node:assert/strict';
import { inProgress } from '../src/ui/github/progress.js';
import type { GhIssue } from '@orca-office/shared/office/protocol';

const issue = (extra: Partial<GhIssue> = {}): GhIssue => ({ number: 7, title: 'Fix the door', state: 'OPEN', url: '', author: 'ada', labels: [], assignees: [], createdAt: '', updatedAt: '', body: '', comments: 0, ...extra });

test('an issue nobody has taken is not in progress', () => {
  assert.equal(inProgress(issue()), false);
  assert.equal(inProgress(issue({ labels: [{ name: 'bug', color: '#d73a4a' }] })), false);
});

test('an assigned issue is in progress', () => {
  assert.equal(inProgress(issue({ assignees: ['ada'] })), true);
});

test('an issue a worker just took is in progress before GitHub lists its assignee', () => {
  assert.equal(inProgress(issue({ taken: true })), true);
});

test('an in-progress label puts an issue in progress, however it is spelled', () => {
  for (const name of ['in progress', 'In-Progress', 'doing', 'WIP', 'started']) assert.equal(inProgress(issue({ labels: [{ name, color: '#fff' }] })), true, name);
});
