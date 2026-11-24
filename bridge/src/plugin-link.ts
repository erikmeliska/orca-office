import { randomUUID } from 'node:crypto';

/**
 * The bridge's side of the single plugin connection: tracks it and turns
 * `call` requests into promises resolved by the plugin's `result` messages.
 */
export interface LinkSocket {
  send(data: string): void;
  close(): void;
}

export interface CallResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  message?: string;
}

export class PluginLink {
  private socket: LinkSocket | null = null;
  private pending = new Map<string, { resolve: (r: CallResult) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly timeoutMs = 5_000) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  /** A newer plugin connection replaces the old one (plugin reload). */
  attach(socket: LinkSocket): void {
    if (this.socket && this.socket !== socket) this.socket.close();
    this.socket = socket;
  }

  detach(socket: LinkSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'disconnected' });
      this.pending.delete(id);
    }
  }

  /** A one-way message to the plugin (e.g. `resync`); false when it isn't connected. */
  send(msg: unknown): boolean {
    if (!this.socket) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  call(method: string, params?: unknown): Promise<CallResult> {
    const socket = this.socket;
    if (!socket) return Promise.resolve({ ok: false, error: 'plugin_offline' });
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      socket.send(JSON.stringify({ type: 'call', id, method, params }));
    });
  }

  /** Feed a `result` message from the plugin. Returns false if unknown. */
  settle(msg: { id?: unknown } & CallResult): boolean {
    if (typeof msg.id !== 'string') return false;
    const p = this.pending.get(msg.id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    const { ok, value, error, message } = msg;
    p.resolve({ ok, value, error, message });
    return true;
  }
}
