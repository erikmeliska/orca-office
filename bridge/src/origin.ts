/**
 * WebSocket upgrades are checked by path and Origin. A browser tab on any site
 * can open ws://127.0.0.1, so loopback alone is not enough (design #20):
 * - `/plugin` is for the Orca worker, a Node process that sends no Origin;
 *   any request with an Origin is refused.
 * - `/client` accepts only the office page itself.
 */
export type Peer = 'plugin' | 'client';

export function allowedClientOrigins(clientPort: number): Set<string> {
  return new Set([`http://127.0.0.1:${clientPort}`, `http://localhost:${clientPort}`]);
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
