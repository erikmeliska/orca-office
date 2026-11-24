import { describe, expect, it, vi } from 'vitest';
import { PluginLink, type LinkSocket } from './plugin-link.js';

function fakeSocket() {
  const sent: string[] = [];
  const socket: LinkSocket & { sent: string[]; closed: boolean } = {
    sent,
    closed: false,
    send: (d) => void sent.push(d),
    close() {
      this.closed = true;
    },
  };
  return socket;
}

describe('PluginLink', () => {
  it('answers plugin_offline without a socket', async () => {
    expect(await new PluginLink().call('agents.list')).toEqual({ ok: false, error: 'plugin_offline' });
  });

  it('resolves a call with the matching result', async () => {
    const link = new PluginLink();
    const s = fakeSocket();
    link.attach(s);
    const p = link.call('terminal.read', { terminalId: 't1' });
    const req = JSON.parse(s.sent[0]!);
    expect(req).toMatchObject({ type: 'call', method: 'terminal.read', params: { terminalId: 't1' } });
    expect(link.settle({ id: req.id, ok: true, value: { lines: [] } })).toBe(true);
    expect(await p).toEqual({ ok: true, value: { lines: [] }, error: undefined, message: undefined });
  });

  it('times out', async () => {
    vi.useFakeTimers();
    const link = new PluginLink(100);
    link.attach(fakeSocket());
    const p = link.call('x');
    vi.advanceTimersByTime(101);
    expect(await p).toEqual({ ok: false, error: 'timeout' });
    vi.useRealTimers();
  });

  it('fails pending calls on detach and closes a replaced socket', async () => {
    const link = new PluginLink();
    const a = fakeSocket();
    link.attach(a);
    const p = link.call('x');
    link.detach(a);
    expect(await p).toEqual({ ok: false, error: 'disconnected' });
    link.attach(a);
    const b = fakeSocket();
    link.attach(b);
    expect(a.closed).toBe(true);
    link.detach(a);
    expect(link.connected).toBe(true);
  });
});
