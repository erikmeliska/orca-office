// The GitHub windows behind the board cards (a PR, an issue, the label picker) live in github/; this
// is where the rest of the client finds them.
export { routePullMessage } from './github/api';
import type { GhIssue, GhPull } from '@orca-office/shared/office/protocol';
import type { Net } from '../net';
import { openIssue as openIssueWindow } from './github/issue-window';
import { openPull as openPullWindow } from './github/pull-window';
import type { BoardActions } from './github/prompts';
import { openLink } from './links';
import { isOrca } from './orca';
export { labelChip, openLabels } from './github/labels';

// On Orca the office has no GitHub of its own (its /api is agent-office's): a card opens where it lives (#32).
export function openIssue(it: GhIssue, net: Net, actions: BoardActions) {
  if (isOrca()) return void openLink(it.url);
  openIssueWindow(it, net, actions);
}

export function openPull(it: GhPull, net: Net, actions: BoardActions) {
  if (isOrca()) return void openLink(it.url);
  openPullWindow(it, net, actions);
}
