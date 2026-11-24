/**
 * WebSocket upgrades are checked by path and Origin. A browser tab on any site
 * can open ws://127.0.0.1, so loopback alone is not enough (design #20):
 * - `/plugin` is for the Orca worker, a Node process that sends no Origin;
 *   any request with an Origin is refused, and the worker must also present
 *   the shared token (see auth.ts), checked by the caller.
 * - `/client` accepts only the office page itself: from Vite (the client port, while developing) or
 *   from the bridge's own port, which serves the built page (static.ts).
 */
export type Peer = 'plugin' | 'client';

export function allowedClientOrigins(...ports: number[]): Set<string> {
  return new Set(ports.flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]));
}

export function checkUpgrade(
  path: string | undefined,
  origin: string | undefined,
  clientOrigins: Set<string>,
): Peer | null {
  const pathname = (path ?? '').split('?')[0];
  if (pathname === '/plugin') return origin === undefined ? 'plugin' : null;
  if (pathname === '/client') return origin !== undefined && clientOrigins.has(origin) ? 'client' : null;
  return null;
}
