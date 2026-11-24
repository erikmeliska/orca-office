import { describe, expect, test } from 'vitest';
import { isLive, parseGates, parseInbox, parseRunList, parseRunShow, parseTasks, parseWorkers, type OrcaRun } from './runs.js';
import { RunsPoller } from './runs-poller.js';

// Made-up data in the shapes Orca 1.4.272 prints (docs/spike-m0.md #5).
const ok = (result: unknown) => ({ id: 'x', ok: true, result });
const long = 'A made-up objective that is long enough to need cutting well past the sixty characters';

describe('orchestration parsing', () => {
  test('runs, run-show, tasks: private text cut to 60', () => {
    expect(parseRunList(ok({ runs: [{ id: 'run_a', objective: long }, { id: '' }, null] }))).toEqual([{ id: 'run_a' }]);
    const head = parseRunShow(ok({ run: { id: 'run_a', objective: long, coordinator_handle: null, legacy: 0, created_at: '2026-11-24T10:00:00Z', updated_at: '2026-11-24T11:00:00Z' } }))!;
    expect(head).toMatchObject({ id: 'run_a', coordinatorHandle: null, legacy: false, updatedAt: Date.parse('2026-11-24T11:00:00Z') });
    expect([...head.objective!].length).toBeLessThanOrEqual(60);
    expect(parseRunShow({ id: 'x', ok: false, error: { code: 'run_not_found' } })).toBeNull();
    expect(parseTasks(ok({ tasks: [{ id: 't1', status: 'dispatched', title: 'Made-up task' }, { id: 't2', status: 'weird', title: 'x' }] }))).toEqual([{ id: 't1', status: 'dispatched', title: 'Made-up task' }]);
  });

  test('gates: pending only, options from a JSON string', () => {
    const gates = parseGates(ok({ gates: [{ id: 'g1', taskId: 't1', status: 'pending', question: 'Ship it?', options: '["yes","no"]' }, { id: 'g2', taskId: 't1', status: 'resolved', question: 'Old' }] }));
    expect(gates).toEqual([{ id: 'g1', taskId: 't1', question: 'Ship it?', options: ['yes', 'no'] }]);
  });

  test('workers and the inbox (bodies never read)', () => {
    expect(parseWorkers(ok({ workers: [{ dispatchId: 'ctx_1', taskId: 't1', state: 'running', workspace: 'repo-1::/code/demo/a', host: 'local' }] }))).toEqual([{ dispatchId: 'ctx_1', taskId: 't1', state: 'running', workspace: 'repo-1::/code/demo/a', host: 'local' }]);
    const mail = parseInbox(ok({ messages: [
      { id: 'm1', type: 'worker_done', from: 'structworker_1', to: 'run:run_a', subject: 'Done with the made-up task', body: 'SECRET BODY', payload: { dispatchId: 'ctx_1', taskId: 't1' } },
      { id: 'm2', type: 'status', from: 'orca_session_id:s1', to: 'dispatch:ctx_1', subject: 'x', body: 'SECRET' },
    ] }));
    expect(mail[0]).toEqual({ id: 'm1', kind: 'worker_done', from: 'structworker_1', to: 'run:run_a', subject: 'Done with the made-up task', dispatchId: 'ctx_1', taskId: 't1' });
    expect(mail[1]!.kind).toBeNull();
    expect(JSON.stringify(mail)).not.toContain('SECRET');
  });

  test('a Run is live with open work or a gate, or for a while after its last change', () => {
    const run = (over: Partial<OrcaRun>): OrcaRun => ({ id: 'r', objective: null, coordinatorHandle: null, legacy: false, updatedAt: 0, tasks: [], gates: [], workers: [], ...over });
    expect(isLive(run({ tasks: [{ id: 't', status: 'ready', title: null }] }), 1e12, 1000)).toBe(true);
    expect(isLive(run({ gates: [{ id: 'g', taskId: null, question: null, options: [] }] }), 1e12, 1000)).toBe(true);
    expect(isLive(run({ tasks: [{ id: 't', status: 'completed', title: null }], updatedAt: 1e12 - 10 }), 1e12, 1000)).toBe(true);
    expect(isLive(run({ tasks: [{ id: 't', status: 'completed', title: null }], updatedAt: 0 }), 1e12, 1000)).toBe(false);
    expect(isLive(run({ legacy: true, updatedAt: 1e12 }), 1e12, 1000)).toBe(false);
  });
});

describe('the runs poller', () => {
  test('reads a live Run fully each round, a quiet old one once a minute; one call at a time', async () => {
    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const now = Date.parse('2026-11-24T12:00:00Z');
    const answers: Record<string, unknown> = {
      'orchestration run-list': ok({ runs: [{ id: 'run_live' }, { id: 'run_old' }] }),
      'orchestration run-show --id run_live': ok({ run: { id: 'run_live', objective: 'Live', updated_at: '2026-11-24T11:59:00Z' } }),
      'orchestration run-show --id run_old': ok({ run: { id: 'run_old', objective: 'Old', updated_at: '2026-11-20T10:00:00Z' } }),
      'orchestration task-list --run run_live': ok({ tasks: [{ id: 't1', status: 'dispatched', title: 'x' }] }),
      'orchestration task-list --run run_old': ok({ tasks: [{ id: 't9', status: 'completed', title: 'y' }] }),
      'orchestration gate-list --run run_live': ok({ gates: [] }),
      'orchestration gate-list --run run_old': ok({ gates: [] }),
      'orchestration worker-list --run run_live': ok({ workers: [] }),
      'orchestration worker-list --run run_old': ok({ workers: [] }),
      'orchestration inbox': ok({ messages: [] }),
    };
    const run = async (args: string[]) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const k = Object.keys(answers).find((a) => args.join(' ').startsWith(a))!;
      calls.push(k);
      await Promise.resolve();
      inFlight--;
      return answers[k];
    };
    let got: unknown[] = [];
    const p = new RunsPoller(run, { runs: (r) => (got = r), inbox: () => {}, error: (e) => calls.push(`error ${e}`) }, () => now, 1e9);
    await p.poll();
    p.stop();
    expect(got).toHaveLength(2);
    const first = calls.length;
    calls.length = 0;
    // A second round straight after: the old Run is skipped, the live one read again.
    await p.poll();
    p.stop();
    expect(calls.filter((c) => c.includes('run_old'))).toEqual([]);
    expect(calls.filter((c) => c.includes('run_live')).length).toBe(4);
    expect(first).toBeGreaterThan(calls.length);
    expect(maxInFlight).toBe(1);
  });
});
