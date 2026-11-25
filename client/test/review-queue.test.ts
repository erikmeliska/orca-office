import { expect, test } from 'vitest';
import type { WorkerInfo, WorkerStatus } from '@orca-office/shared/office/protocol';
import type { OrcaForgeItem, OrcaLink } from '@orca-office/shared/office/protocol/orca';
import { reviewQueue } from '../src/review-queue.js';

// Made up: worktrees, pull requests and titles.
const w = (id: string, status: WorkerStatus, since: number): WorkerInfo => ({ id, kind: 'agent', deskId: `desk-${id}`, name: id, color: '#fff', status, acked: false, createdBy: 'orca', createdAt: 0, waitingSince: since, cols: 80, rows: 24, viewers: [], viewerIds: [], orca: { terminal: true, remote: false } });
const links: Record<string, OrcaLink[]> = {
  'desk-a': [{ provider: 'github', kind: 'pr', ref: '#12', url: 'https://github.com/x/y/pull/12' }, { provider: 'github', kind: 'issue', ref: '#3' }],
  'desk-b': [{ provider: 'github', kind: 'pr', ref: '#13' }],
  'desk-c': [{ provider: 'github', kind: 'pr', ref: '#14' }],
  'desk-d': [{ provider: 'github', kind: 'pr', ref: '#99' }],
};
const pulls: OrcaForgeItem[] = [
  { kind: 'pr', ref: '#12', number: 12, title: 'Made-up 12', worktree: true, ci: 'failing', additions: 40, deletions: 2 },
  { kind: 'pr', ref: '#13', number: 13, title: 'Made-up 13', worktree: true, ci: 'passing' },
  { kind: 'pr', ref: '#14', number: 14, title: 'Made-up 14', worktree: true },
];

test('done agents with an open pull request, longest waiting first, with checks and size (M7 B4)', () => {
  const q = reviewQueue([w('a', 'done', 20), w('b', 'done', 10), w('c', 'working', 5), w('d', 'done', 1)], (d) => links[d] ?? [], pulls);
  expect(q.map((r) => [r.name, r.ref, r.ci])).toEqual([
    ['b', '#13', 'passing'],
    ['a', '#12', 'failing'],
  ]);
  expect(q[1]).toMatchObject({ additions: 40, deletions: 2, url: 'https://github.com/x/y/pull/12', title: 'Made-up 12' });
  // Without a board (no gh): what Orca links, checks unknown.
  expect(reviewQueue([w('d', 'done', 1)], (d) => links[d] ?? [], []).map((r) => [r.ref, r.ci])).toEqual([['#99', undefined]]);
});
