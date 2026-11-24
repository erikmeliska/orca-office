/**
 * The bridge lets a `/client` socket in only with the page's token (bridge/src/client-auth.ts),
 * which the page's own server hands to same-origin fetches (client/vite-token.ts). Kept in memory
 * only, never in storage or the URL.
 */
const TOKEN_URL = '/__orca-office/token';

let token: string | null = null;

/** The token, fetched once per page (again after a failure). */
export async function bridgeToken(): Promise<string | null> {
  if (token) return token;
  try {
    const res = await fetch(TOKEN_URL, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    token = typeof body.token === 'string' && /^[0-9a-f]{64}$/.test(body.token) ? body.token : null;
  } catch {
    token = null;
  }
  return token;
}

/** Drops the token, so the next socket fetches it again. */
export function forgetBridgeToken() {
  token = null;
}

/** The subprotocols a `/client` socket asks for: the office protocol and the token. */
export function bridgeProtocols(t: string): string[] {
  return ['orca-office', `token.${t}`];
}

/** Opens a socket to the bridge with the page's token; null when there's no token to be had. */
export async function openBridge(url: string): Promise<WebSocket | null> {
  const t = await bridgeToken();
  return t ? new WebSocket(url, bridgeProtocols(t)) : null;
}
