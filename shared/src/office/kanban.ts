// A worktree's Kanban status in Orca (M7, roadmap B10): `workspaceStatus` from `orca worktree list
// --json` ("in-progress", "in-review", …). Seen on Orca 1.4.274: only "in-progress" so far; any other
// short id is shown as it comes, in a neutral colour.

/** What the bridge passes on: a short lowercase id, nothing else. */
export function cleanKanban(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,30}$/.test(s) ? s : null;
}

const KNOWN: Record<string, { label: string; color: string; ink: string }> = {
  backlog: { label: 'Backlog', color: '#adb5bd', ink: '#2b2d42' },
  todo: { label: 'To do', color: '#adb5bd', ink: '#2b2d42' },
  'to-do': { label: 'To do', color: '#adb5bd', ink: '#2b2d42' },
  planned: { label: 'Planned', color: '#adb5bd', ink: '#2b2d42' },
  'in-progress': { label: 'In progress', color: '#ffd166', ink: '#2b2d42' },
  doing: { label: 'In progress', color: '#ffd166', ink: '#2b2d42' },
  blocked: { label: 'Blocked', color: '#ef476f', ink: '#fffaf3' },
  review: { label: 'In review', color: '#9b5de5', ink: '#fffaf3' },
  'in-review': { label: 'In review', color: '#9b5de5', ink: '#fffaf3' },
  done: { label: 'Done', color: '#06d6a0', ink: '#2b2d42' },
  merged: { label: 'Merged', color: '#06d6a0', ink: '#2b2d42' },
  completed: { label: 'Done', color: '#06d6a0', ink: '#2b2d42' },
};

/** How a status reads and what colour its strip is. */
export function kanbanStyle(status: string): { label: string; color: string; ink: string } {
  const k = KNOWN[status];
  if (k) return k;
  const label = status.replace(/[-_]+/g, ' ');
  return { label: label.charAt(0).toUpperCase() + label.slice(1), color: '#118ab2', ink: '#fffaf3' };
}

/** The order columns and filters list them in: known ones first, by how far along they are. */
export function kanbanRank(status: string): number {
  const order = ['backlog', 'todo', 'to-do', 'planned', 'in-progress', 'doing', 'blocked', 'review', 'in-review', 'done', 'merged', 'completed'];
  const i = order.indexOf(status);
  return i < 0 ? order.length : i;
}
