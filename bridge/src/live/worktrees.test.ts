import { describe, expect, test } from 'vitest';
import { parseWorktreeList, pinsText, repoBase, safeUrl } from './worktrees.js';

// Made-up rows in the shape `orca worktree list --json` prints (checked on Orca 1.4.272).
const row = (over: Record<string, unknown> = {}) => ({
  id: 'repo-1::/code/demo/a',
  repoId: 'repo-1',
  path: '/code/demo/a',
  hostId: 'local',
  displayName: 'a',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  linkedLinearIssueOrganizationUrlKey: null,
  linkedGitLabMR: null,
  linkedGitLabIssue: null,
  linkedWorkItem: null,
  linkedItems: [],
  parentWorktreeId: null,
  childWorktreeIds: [],
  lineage: null,
  ...over,
});
const wrap = (...worktrees: unknown[]) => ({ id: 'x', ok: true, result: { worktrees, totalCount: worktrees.length, truncated: false } });

describe('orca worktree list → desk links (#32)', () => {
  test('linkedItems with urls, titles cut to 60 characters', () => {
    const long = 'A made-up pull request title that goes on and on well past sixty characters for sure';
    const [w] = parseWorktreeList(wrap(row({ linkedPR: 12, linkedItems: [{ provider: 'github', type: 'pr', number: 12, url: 'https://github.com/o/r/pull/12', title: long, origins: [] }] })));
    expect(w!.links).toEqual([{ provider: 'github', kind: 'pr', ref: '#12', url: 'https://github.com/o/r/pull/12', title: expect.stringMatching(/…$/) }]);
    expect([...w!.links[0]!.title!].length).toBeLessThanOrEqual(60);
  });

  test('an item without a url gets one from another url of the same repository', () => {
    const list = parseWorktreeList(
      wrap(
        row({ linkedItems: [{ provider: 'github', type: 'issue', number: 7, title: 'Made-up issue' }] }),
        row({ id: 'repo-1::/code/demo/b', path: '/code/demo/b', linkedItems: [{ provider: 'github', type: 'pr', number: 5, url: 'https://github.com/o/r/pull/5' }] }),
      ),
    );
    expect(list[0]!.links[0]).toMatchObject({ kind: 'issue', ref: '#7', url: 'https://github.com/o/r/issues/7' });
  });

  test('older single fields, GitLab, Linear and a Jira work item', () => {
    const [w] = parseWorktreeList(
      wrap(
        row({
          linkedGitLabMR: 4,
          linkedLinearIssue: 'ENG-42',
          linkedLinearIssueOrganizationUrlKey: 'demo',
          linkedWorkItem: { key: 'OPS-9', url: 'https://demo.atlassian.net/browse/OPS-9', title: 'Made-up ticket' },
          linkedItems: [{ provider: 'gitlab', type: 'issue', number: 2, url: 'https://gitlab.com/g/p/-/issues/2' }],
        }),
      ),
    );
    expect(w!.links.map((l) => [l.provider, l.kind, l.ref, l.url])).toEqual([
      ['gitlab', 'issue', '#2', 'https://gitlab.com/g/p/-/issues/2'],
      ['gitlab', 'mr', '!4', 'https://gitlab.com/g/p/-/merge_requests/4'],
      ['linear', 'issue', 'ENG-42', 'https://linear.app/demo/issue/ENG-42'],
      ['jira', 'item', 'OPS-9', 'https://demo.atlassian.net/browse/OPS-9'],
    ]);
  });

  test('the same item twice is listed once; a number without any url stays without one', () => {
    const [w] = parseWorktreeList(wrap(row({ linkedPR: 3, linkedItems: [{ provider: 'github', type: 'pr', number: 3 }] })));
    expect(w!.links).toEqual([{ provider: 'github', kind: 'pr', ref: '#3' }]);
  });

  test('only https urls leave the bridge', () => {
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('http://github.com/o/r/pull/1')).toBeUndefined();
    expect(safeUrl('https://user:pw@github.com/x')).toBeUndefined();
    expect(safeUrl('https://github.com/o/r/pull/1')).toBe('https://github.com/o/r/pull/1');
    const [w] = parseWorktreeList(wrap(row({ linkedItems: [{ provider: 'github', type: 'pr', number: 1, url: 'javascript:alert(1)' }] })));
    expect(w!.links[0]!.url).toBeUndefined();
  });

  test('lineage: parent and children', () => {
    const [w] = parseWorktreeList(wrap(row({ parentWorktreeId: null, childWorktreeIds: ['repo-2::/code/x', 7], lineage: null })));
    expect(w!.childIds).toEqual(['repo-2::/code/x']);
    const [c] = parseWorktreeList(wrap(row({ lineage: { parentWorktreeId: 'repo-1::/code/demo/main' } })));
    expect(c!.parentId).toBe('repo-1::/code/demo/main');
  });

  test('garbage in, nothing out', () => {
    expect(parseWorktreeList(null)).toEqual([]);
    expect(parseWorktreeList({ result: { worktrees: [null, 1, { id: 'x' }] } })).toEqual([]);
  });

  test('repo base and the pin strip', () => {
    expect(repoBase('https://github.com/o/r/pull/5')).toBe('https://github.com/o/r');
    expect(repoBase('https://gitlab.com/g/sub/p/-/merge_requests/9')).toBe('https://gitlab.com/g/sub/p');
    expect(pinsText([])).toBe('');
    expect(pinsText([{ provider: 'github', kind: 'pr', ref: '#1' }, { provider: 'github', kind: 'issue', ref: '#2' }, { provider: 'linear', kind: 'issue', ref: 'E-1' }])).toBe('🔀 #1 · 📌 #2 +1');
  });
});
