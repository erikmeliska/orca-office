import type { ClientMsg, ServerMsg } from '@orca-office/shared/office/protocol';
import { forgetBridgeToken, openBridge } from './bridge-auth';
import { lastFloor, store, type Profile, type Spot } from './state';

type Handler = (msg: ServerMsg) => void;

/**
 * The orca-office bridge's socket for the office page (bridge/src/origin.ts lets only this page's
 * origin in). The bridge listens on 127.0.0.1 only; its port comes from ORCA_OFFICE_PORT at build
 * time (see vite.config.ts).
 */
export const BRIDGE_URL = `ws://127.0.0.1:${__ORCA_OFFICE_BRIDGE_PORT__}/client`;

export class Net {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  private statusHandlers: ((up: boolean) => void)[] = [];
  private retry = 0;
  private closedByUs = false;
  /** The server is restarting on purpose: retry every second instead of backing off. */
  private restartExpected = false;
  up = false;

  constructor(
    private profile: () => Profile,
    /** Where you are (or were, before this page), to be put back in the same spot. */
    private where: () => Spot | null,
    /** On the 2D view: in the office without standing anywhere in it (see PeerInfo.lite). */
    private lite = false,
  ) {}

  onMessage(h: Handler) {
    this.handlers.push(h);
  }

  onStatus(h: (up: boolean) => void) {
    this.statusHandlers.push(h);
  }

  connect() {
    const { name, color, look } = this.profile();
    const q = new URLSearchParams({ name, color, skin: String(look.skin), hair: String(look.hair), style: String(look.style) });
    // Back to the floor you were on (after a reload or a restart), in the spot you were in there.
    const floor = store.floor ?? lastFloor();
    if (floor) q.set('floor', floor);
    if (this.lite) q.set('lite', '1');
    const at = this.where();
    if (floor && at?.floor === floor) {
      for (const k of ['x', 'y', 'z'] as const) q.set(k, at[k].toFixed(2));
      q.set('rotY', at.facing.toFixed(3));
    }
    void openBridge(`${BRIDGE_URL}?${q}`).then((ws) => {
      if (!ws) return this.retryLater();
      this.attach(ws);
    });
  }

  /** No socket (no token, or it closed): try again, backing off. */
  private retryLater() {
    if (this.closedByUs) return;
    const delay = this.restartExpected ? 1000 : Math.min(8000, 500 * 2 ** this.retry++);
    setTimeout(() => this.connect(), delay);
  }

  private attach(ws: WebSocket) {
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.retry = 0;
      this.up = true;
      this.statusHandlers.forEach((h) => h(true));
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const h of this.handlers) h(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      // Turned away before it opened: the token may be stale (made anew), so fetch it again.
      if (!opened) forgetBridgeToken();
      this.up = false;
      this.statusHandlers.forEach((h) => h(false));
      this.retryLater();
    };
  }

  expectRestart() {
    this.restartExpected = true;
  }

  send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
