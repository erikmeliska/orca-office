/**
 * The read-only LAN view (v2, #39, design #20): a second port for a TV or a phone on the LAN.
 *
 * Off unless ORCA_OFFICE_LAN_PORT is set, and then only on the address ORCA_OFFICE_LAN_HOST names
 * (both required; never on by default). The LAN port is a separate HTTP server that serves only the
 * TV page (`/`, `/tv`) and its assets, and one WebSocket, `/lan`. Nothing else of the bridge is
 * reachable there: no `/client`, no `/plugin`, no token, no terminals, actions, chats or bots.
 *
 * Enforced on the server, not by the page:
 * - The socket only ever sends `lan.view` (lanView below: floors, desks, figures, states, badges; no
 *   text an agent, a prompt, a terminal, a chat or a Run wrote) and `pong`.
 * - It takes only `{ t: 'ping', at }` (LAN_LIMITS.frame bytes at most, LAN_LIMITS.messagesPerMinute);
 *   anything else closes it (1008). At most LAN_LIMITS.sockets at a time.
 * - Host must be the configured address and port (DNS rebinding); a WebSocket's Origin must be the
 *   page's own (`http://<host>:<port>`).
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { LanDesk, LanFigure, LanFloor, LanView } from '@orca-office/shared/office/protocol/lan';
import { LAN_LIMITS } from '@orca-office/shared/office/protocol/lan';
import type { Building } from './live/model.js';

export interface LanConfig {
  host: string;
  port: number;
}

/** The LAN side's address, or null when it is off (the default). Throws on a half or bad setting. */
export function lanConfig(env: Record<string, string | undefined>, mainPort: number): LanConfig | null {
  const rawPort = env.ORCA_OFFICE_LAN_PORT;
  const host = env.ORCA_OFFICE_LAN_HOST?.trim();
  if (rawPort === undefined || rawPort === '') return null;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`ORCA_OFFICE_LAN_PORT must be a port number, got "${rawPort}"`);
  if (port === mainPort) throw new Error('ORCA_OFFICE_LAN_PORT must differ from ORCA_OFFICE_PORT');
  // An explicit IPv4 address: the interface the TV can reach. No wildcard, no names.
  if (!host || !/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host) || host.split('.').some((n) => Number(n) > 255)) {
    throw new Error('ORCA_OFFICE_LAN_HOST must be the IPv4 address to listen on (e.g. 192.168.1.20); 0.0.0.0 is not allowed');
  }
  if (host === '0.0.0.0') throw new Error('ORCA_OFFICE_LAN_HOST must be one address, not 0.0.0.0');
  return { host, port };
}

/** Requests must name the LAN address itself (no other names: DNS rebinding). */
export function lanHostAllowed(hostHeader: string | undefined, c: LanConfig): boolean {
  return hostHeader === `${c.host}:${c.port}` || (c.port === 80 && hostHeader === c.host);
}

/** The one WebSocket on the LAN port: `/lan`, from the TV page itself. */
export function lanUpgradeAllowed(url: string | undefined, headers: IncomingHttpHeaders, c: LanConfig): boolean {
  const path = (url ?? '').split('?')[0];
  if (path !== '/lan' || !lanHostAllowed(headers.host, c)) return false;
  const origin = headers.origin;
  return origin === `http://${c.host}:${c.port}` || (c.port === 80 && origin === `http://${c.host}`);
}

/** Which files of the built client the LAN port serves: the TV page and the assets it loads. */
export function lanStaticPath(urlPath: string): string | null {
  const p = (urlPath.split('?')[0] ?? '').split('#')[0] ?? '';
  if (p === '/' || p === '/tv' || p === '/tv/' || p === '/tv.html') return '/tv.html';
  if (/^\/assets\/[A-Za-z0-9._-]+\.(js|css|woff2?|svg|png)$/.test(p)) return p;
  if (p === '/favicon.svg' || p === '/favicon.ico') return p;
  return null;
}

/**
 * What a LAN page may know of the building, built field by field from an allowlist: names the office
 * made up, colors, states, actions, counts, desk signs. Never a figure's title, activity, prompt or
 * last message, a link's title, a Run's objective or a task's title.
 */
export function lanView(b: Building, online: boolean, now: number): LanView {
  const floors: LanFloor[] = b.floors.map((f) => {
    const room = f.info.room;
    const desks = new Map<string, LanDesk>();
    // Desk signs: a seat's label names its desk (Orca's worktree name; the bot's name on the Staff floor).
    // In a project room the signs carry task status and coordinator: left out, the room is just seats.
    const signOf = (deskId: string) => (room === 'project' ? '' : cleanSign(f.plan.labels[deskId]?.text ?? ''));
    for (const w of f.workers) {
      let d = desks.get(w.deskId);
      if (!d) desks.set(w.deskId, (d = { name: signOf(w.deskId), figures: [] }));
      const fig: LanFigure = {
        name: String(w.name).slice(0, 24),
        color: /^#[0-9a-fA-F]{6}$/.test(w.color) ? w.color : '#888888',
        status: w.status,
        ...(w.provider ? { provider: w.provider } : {}),
        ...(w.action ? { action: w.action } : {}),
        ...(w.helpers ? { helpers: Math.min(99, w.helpers) } : {}),
        ...(w.orca?.remote ? { remote: true } : {}),
        ...(w.orca?.bot ? { bot: String(w.orca.bot).slice(0, 40) } : {}),
      };
      d.figures.push(fig);
    }
    // Empty desks (an open worktree without agents) have a sign and no figures.
    if (room !== 'project') {
      for (const [seat, label] of Object.entries(f.plan.labels)) {
        if (desks.has(seat) || !label?.text) continue;
        desks.set(seat, { name: cleanSign(label.text), figures: [] });
      }
    }
    return {
      id: f.info.id,
      name: room === 'project' ? 'Project room' : room === 'staff' ? 'Staff' : String(f.info.name).slice(0, 60),
      ...(room ? { room } : {}),
      waiting: f.info.waiting,
      busy: f.info.busy,
      workers: f.info.workers,
      desks: [...desks.values()],
    };
  });
  return { t: 'lan.view', online, floors, at: now };
}

/** A desk sign's text, one line and short. */
function cleanSign(s: string): string {
  return [...s].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').trim().slice(0, 48);
}

/**
 * What the LAN socket does with a frame from the page: a pong for a ping, else close it. The caller
 * counts frames per minute and closes past the limit too.
 */
export function lanReply(raw: string, now: number): { reply: string } | { close: true } {
  if (raw.length > LAN_LIMITS.frame) return { close: true };
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { close: true };
  }
  const m = msg as { t?: unknown; at?: unknown };
  if (typeof msg !== 'object' || msg === null || m.t !== 'ping' || typeof m.at !== 'number' || !Number.isFinite(m.at) || Object.keys(msg).length !== 2) return { close: true };
  return { reply: JSON.stringify({ t: 'pong', at: m.at, now }) };
}
