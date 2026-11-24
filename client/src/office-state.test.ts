import { describe, expect, it } from 'vitest';
import { applySnapshot, applyStatus, emptyOffice, workspaceRank, type SnapshotMessage, type StatusEvent } from './office-state.js';

const snap: SnapshotMessage = {
  type: 'snapshot',
  at: 1,
  workspaces: [
    { id: 'w1', kind: 'worktree', name: 'main', project: 'app', branch: 'main', hostId: 'local', status: { state: 'active', unread: false, lastActivityAt: 5 } },
    { id: 'w2', kind: 'folder', name: 'ReleaseBot', branch: null, hostId: null },
  ],
  agents: {
    w1: [{ terminalId: 't1', agent: 'claude', state: 'done', stateStartedAt: 2, sessionId: 's1' }],
    w2: { error: 'unavailable' },
  },
};

const ev = (state: StatusEvent['payload']['state'], extra: Partial<StatusEvent['payload']> = {}): StatusEvent => ({
  type: 'event',
  name: 'agent.status.changed',
  payload: { workspaceListId: 'w1', paneKey: 'p1', terminalId: 't1', sessionId: 's1', state, receivedAt: 10, ...extra },
});

describe('office state', () => {
  it('builds workspaces and agents from a snapshot', () => {
    const o = applySnapshot(emptyOffice(), snap);
    expect(o.workspaces.get('w1')!.agents.get('s1')).toMatchObject({ agent: 'claude', state: 'done', surface: 'terminal' });
    expect(o.workspaces.get('w2')!.project).toBe('Folders');
    expect(o.workspaces.get('w2')!.agents.size).toBe(0);
  });

  it('applies changes and ignores repeats', () => {
    const o = applySnapshot(emptyOffice(), snap);
    expect(applyStatus(o, ev('working'))).toBe(true);
    expect(applyStatus(o, ev('working'))).toBe(false);
    expect(o.workspaces.get('w1')!.agents.get('s1')!.agent).toBe('claude');
  });

  it('adds chat agents without a terminal', () => {
    const o = applySnapshot(emptyOffice(), snap);
    applyStatus(o, ev('blocked', { terminalId: undefined, sessionId: 's2', paneKey: 'chat' }));
    expect(o.workspaces.get('w1')!.agents.get('s2')!.surface).toBe('chat');
    expect(workspaceRank(o.workspaces.get('w1')!)).toBe(0);
  });

  it('ignores unknown workspaces', () => {
    expect(applyStatus(applySnapshot(emptyOffice(), snap), ev('done', { workspaceListId: 'nope' }))).toBe(false);
  });
});
