/**
 * `orca worktree list --json` (this machine): what Orca links to each worktree, and its lineage
 * (issue #32; design #8, #10). Real shape, checked on Orca 1.4.272:
 *
 *   result.worktrees[]: id (`<repoId>::<path>`), repoId, path, hostId, displayName,
 *     linkedPR / linkedIssue (numbers), linkedGitLabMR, linkedGitLabIssue, linkedLinearIssue,
 *     linkedLinearIssueOrganizationUrlKey, linkedWorkItem, linkedBitbucketPR, linkedAzureDevOpsPR,
 *     linkedGiteaPR (null when unset),
 *     linkedItems[]: { provider, type: 'pr' | 'issue', number, url?, title? },
 *     parentWorktreeId, childWorktreeIds[], lineage { parentWorktreeId, … }
 *
 * `linkedItems` is what Orca observed; the single fields are older and carry only numbers. Some
 * items come without a url; the office then derives one from another url of the same repository
 * (never by asking a forge). Titles are private (design #20): cut with toBubble at once, the
 * original dropped. Nothing here is logged or stored.
 */
import { toBubble } from '@orca-office/shared';
import { ORCA_LINK_TITLE, ORCA_LINKS_PER_DESK, type OrcaLink } from '@orca-office/shared/office/protocol/orca';

export interface OrcaWorktree {
  /** `<repoId>::<path>`, the form the CLI and orchestration use. */
  id: string;
  repoId: string | null;
  /** Orca's project (`repo:…`, `github:owner/name`…), the id `workspace.list` rows name as `projectId`. */
  projectId: string | null;
  /** The repository's own checkout, not a worktree Orca added (a floor's directory). */
  isMain: boolean;
  path: string;
  hostId: string;
  /** Orca's name for it (the desk sign shows it already). */
  name: string;
  /** Its branch without `refs/heads/` (null: detached or unknown); the repo board matches pull requests by it (#38). */
  branch: string | null;
  links: OrcaLink[];
  parentId: string | null;
  childIds: string[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

/** Only https links leave the bridge: the page opens them in a new tab. */
export function safeUrl(v: unknown): string | undefined {
  const s = str(v);
  if (!s || s.length > 500) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const PROVIDERS = new Set(['github', 'gitlab', 'linear', 'jira', 'bitbucket', 'azure', 'gitea']);
function provider(v: unknown): OrcaLink['provider'] {
  const s = str(v)?.toLowerCase() ?? '';
  if (s === 'azuredevops' || s === 'azure-devops') return 'azure';
  return (PROVIDERS.has(s) ? s : 'other') as OrcaLink['provider'];
}

/** A repository's web address from one of its item urls: `https://github.com/o/r/pull/5` → `https://github.com/o/r`. */
export function repoBase(url: string): string | null {
  const m = /^(https:\/\/[^/]+\/.+?)(?:\/-)?\/(?:pull|pulls|issues|merge_requests)\/\d+\/?$/.exec(url);
  return m ? m[1]! : null;
}

function itemUrl(p: OrcaLink['provider'], kind: OrcaLink['kind'], n: number, base: string | null): string | undefined {
  if (!base) return undefined;
  if (p === 'github') return `${base}/${kind === 'pr' ? 'pull' : 'issues'}/${n}`;
  if (p === 'gitlab') return `${base}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${n}`;
  return undefined;
}

function rawRows(json: unknown): Obj[] {
  const o = obj(json);
  const r = obj(o?.result) ?? o;
  return Array.isArray(r?.worktrees) ? (r.worktrees.map(obj).filter(Boolean) as Obj[]) : [];
}

export function parseWorktreeList(json: unknown): OrcaWorktree[] {
  const rows = rawRows(json);
  // Repository web addresses from every url Orca gave, per repo and provider.
  const bases = new Map<string, string>();
  for (const w of rows) {
    const repo = str(w.repoId);
    for (const it of Array.isArray(w.linkedItems) ? w.linkedItems : []) {
      const u = safeUrl(obj(it)?.url);
      const b = u && repoBase(u);
      if (repo && b) bases.set(`${repo}|${provider(obj(it)?.provider)}`, b);
    }
  }
  const out: OrcaWorktree[] = [];
  for (const w of rows) {
    const id = str(w.id);
    const path = str(w.path) ?? str(obj(w.git)?.path);
    if (!id || !path) continue;
    const repoId = str(w.repoId);
    const base = (p: OrcaLink['provider']) => (repoId ? (bases.get(`${repoId}|${p}`) ?? null) : null);
    const links: OrcaLink[] = [];
    const seen = new Set<string>();
    const add = (l: OrcaLink) => {
      const k = `${l.provider}|${l.kind}|${l.ref}`;
      if (seen.has(k) || links.length >= ORCA_LINKS_PER_DESK) return;
      seen.add(k);
      links.push(l);
    };
    for (const raw of Array.isArray(w.linkedItems) ? w.linkedItems : []) {
      const it = obj(raw);
      const n = int(it?.number);
      if (!it || !n) continue;
      const p = provider(it.provider);
      const kind: OrcaLink['kind'] = it.type === 'pr' ? (p === 'gitlab' ? 'mr' : 'pr') : it.type === 'mr' ? 'mr' : it.type === 'issue' ? 'issue' : 'item';
      const url = safeUrl(it.url) ?? itemUrl(p, kind, n, base(p));
      const title = toBubble(str(it.title), ORCA_LINK_TITLE);
      add({ provider: p, kind, ref: `${kind === 'mr' ? '!' : '#'}${n}`, ...(url ? { url } : {}), ...(title ? { title } : {}) });
    }
    // The older single fields, for what linkedItems doesn't list.
    const num = (field: string, p: OrcaLink['provider'], kind: OrcaLink['kind']) => {
      const n = int(w[field]) ?? int(obj(w[field])?.number);
      if (!n) return;
      const url = safeUrl(obj(w[field])?.url) ?? itemUrl(p, kind, n, base(p));
      add({ provider: p, kind, ref: `${kind === 'mr' ? '!' : '#'}${n}`, ...(url ? { url } : {}) });
    };
    num('linkedPR', 'github', 'pr');
    num('linkedIssue', 'github', 'issue');
    num('linkedGitLabMR', 'gitlab', 'mr');
    num('linkedGitLabIssue', 'gitlab', 'issue');
    num('linkedBitbucketPR', 'bitbucket', 'pr');
    num('linkedAzureDevOpsPR', 'azure', 'pr');
    num('linkedGiteaPR', 'gitea', 'pr');
    const linear = linearLink(w.linkedLinearIssue, str(w.linkedLinearIssueOrganizationUrlKey));
    if (linear) add(linear);
    const work = workItemLink(w.linkedWorkItem);
    if (work) add(work);
    out.push({
      id,
      repoId,
      projectId: str(w.projectId),
      isMain: w.isMainWorktree === true,
      path,
      hostId: str(w.hostId) ?? 'local',
      name: str(w.displayName) ?? path.split('/').pop() ?? id,
      branch: (str(w.branch) ?? str(obj(w.git)?.branch))?.replace(/^refs\/heads\//, '') ?? null,
      links,
      parentId: str(w.parentWorktreeId) ?? str(obj(w.lineage)?.parentWorktreeId),
      childIds: Array.isArray(w.childWorktreeIds) ? w.childWorktreeIds.filter((c): c is string => typeof c === 'string' && c !== '') : [],
    });
  }
  return out;
}

const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;

/** A Linear issue: an identifier ("ENG-42"), or an object with one, and the workspace's url key. */
function linearLink(v: unknown, org: string | null): OrcaLink | null {
  const o = obj(v);
  const key = str(o?.identifier) ?? str(o?.id) ?? str(v);
  if (!key || !ISSUE_KEY.test(key)) return null;
  const url = safeUrl(o?.url) ?? (org && /^[a-z0-9-]{1,64}$/i.test(org) ? `https://linear.app/${org}/issue/${key}` : undefined);
  const title = toBubble(str(o?.title), ORCA_LINK_TITLE);
  return { provider: 'linear', kind: 'issue', ref: key, ...(url ? { url } : {}), ...(title ? { title } : {}) };
}

/** A work item (Jira and the like): a key and, when Orca has one, its url. */
function workItemLink(v: unknown): OrcaLink | null {
  const o = obj(v);
  if (!o) return null;
  const key = str(o.key) ?? str(o.identifier) ?? str(o.id);
  const url = safeUrl(o.url);
  if (!key && !url) return null;
  const host = url ? new URL(url).host : '';
  const p: OrcaLink['provider'] = provider(o.provider) !== 'other' ? provider(o.provider) : /atlassian\.net$|jira/i.test(host) ? 'jira' : /linear\.app$/.test(host) ? 'linear' : 'other';
  const title = toBubble(str(o.title), ORCA_LINK_TITLE);
  return { provider: p, kind: 'item', ref: (key ?? 'item').slice(0, 24), ...(url ? { url } : {}), ...(title ? { title } : {}) };
}

/** What a desk's pin strip says: "🔀 #12 · 📌 #34 +2". */
export function pinsText(links: OrcaLink[]): string {
  if (!links.length) return '';
  const icon = (l: OrcaLink) => (l.kind === 'pr' || l.kind === 'mr' ? '🔀' : l.kind === 'issue' ? '📌' : '🔗');
  const shown = links.slice(0, 2).map((l) => `${icon(l)} ${l.ref}`);
  return `${shown.join(' · ')}${links.length > 2 ? ` +${links.length - 2}` : ''}`;
}
