import type { GhIssue, GhMergeMethod, GhPull } from '@orca-office/shared/office/protocol';
import { store } from '../../state';
import { repoUrlOf } from '../markdown';
import { officePrompt } from '../prompts';

// ---- Prompts for workers ------------------------------------------------------------------------

export interface BoardActions {
  /** Start a worker on a ready-made prompt (shown for editing first). With `issue`, the worker takes that GitHub issue, which moves to In progress. */
  assign(prompt: string, title: string, issue?: number): void;
  /** Your own prompt about an issue or PR; `context` goes first so the worker knows which. */
  ask(context: string, title: string): void;
  /** Walks you to the desk a pull request came from. */
  goToDesk(deskId: string): void;
}

/** The task a worker gets for an issue (the 'issue.work' prompt). */
export function issuePrompt(it: Pick<GhIssue, 'number' | 'title'> & { url?: string }): string {
  return officePrompt('issue.work', issueVars(it));
}

/** What an issue's prompts fill in. A carried card has no URL, but the board usually knows it. */
export function issueVars(it: Pick<GhIssue, 'number' | 'title'> & { url?: string }) {
  return { number: it.number, title: it.title, url: it.url ?? store.issues.items.find((i) => i.number === it.number)?.url ?? '' };
}

/** owner/repo from a PR or issue URL. */
function nameWithOwner(url: string): string {
  return repoUrlOf(url).replace(/^https?:\/\/[^/]+\//, '');
}

/** What a pull request's prompts fill in. */
export function pullVars(it: GhPull) {
  return { number: it.number, title: it.title, url: it.url, branch: it.headRefName, base: it.baseRefName };
}

export function reviewPrompt(it: GhPull) {
  return officePrompt('pull.review', pullVars(it));
}

function mergeCommand(it: GhPull, method: GhMergeMethod, deleteBranch: boolean) {
  return `gh pr merge ${it.number} --${method}${deleteBranch ? ' --delete-branch' : ''} --repo ${nameWithOwner(it.url)}`;
}

function mergeVars(it: GhPull, method: GhMergeMethod, deleteBranch: boolean) {
  return { ...pullVars(it), repo: nameWithOwner(it.url), merge: mergeCommand(it, method, deleteBranch) };
}

export function fixAndMergePrompt(it: GhPull, method: GhMergeMethod, deleteBranch: boolean) {
  return officePrompt('pull.fixMerge', mergeVars(it, method, deleteBranch));
}

export function fixConflictsPrompt(it: GhPull, method: GhMergeMethod, deleteBranch: boolean) {
  return officePrompt('pull.fixConflicts', mergeVars(it, method, deleteBranch));
}

export function pullContext(it: GhPull) {
  return officePrompt('pull.ask', pullVars(it));
}

export function issueContext(it: GhIssue) {
  return officePrompt('issue.ask', issueVars(it));
}
