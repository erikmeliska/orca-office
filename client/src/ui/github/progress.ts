import type { GhIssue } from '@orca-office/shared/office/protocol';

/**
 * Whether someone has started on an open issue: a worker just took it (before GitHub lists its
 * assignee), it's assigned, it has an in-progress label. The issues window puts these
 * under In progress.
 */
export function inProgress(issue: GhIssue): boolean {
  return !!issue.taken || issue.assignees.length > 0 || issue.labels.some((l) => /progress|doing|wip|started/i.test(l.name));
}
