import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { tokenMatches } from './auth.js';

/**
 * The office page's token (design #20, M3). `/client` already accepts only the office page's Origin,
 * but a browser is not the only thing that can open a socket on loopback, and from M3 the page can
 * type into terminals and create workspaces. So every `/client` socket also has to present this
 * token, which only the office page can get:
 *
 * - It lives in `~/.orca-office/client-token` (0600 in a 0700 folder), apart from the plugin's
 *   HMAC key (`token`), so a leaked page token never lets anyone pose as the bridge or the worker.
 * - The page's own server (Vite, see client/vite-token.ts) hands it out at `/__orca-office/token`
 *   only to a same-origin `fetch` from the office page: loopback `Host`, the page's own `Origin`,
 *   and `Sec-Fetch-Site: same-origin`, a header page scripts cannot set. Another site, another
 *   port on localhost, a frame or `curl` gets 403. The page is also served with
 *   `X-Frame-Options: DENY`, so it cannot be framed to click its buttons.
 * - The page sends it as a WebSocket subprotocol (`token.<hex>` next to `orca-office`), never in
 *   the URL, so it doesn't end up in logs or history; the bridge refuses the upgrade without it.
 *
 * What this protects against, and what not: it keeps out browsers, i.e. any other website, a page on
 * another local port, a frame, DNS rebinding (the checked headers are ones page scripts cannot set or
 * forge). It does not keep out a program running on this machine: such a program can send any
 * headers it likes to the token endpoint, and one running as this user can read the token file
 * anyway. Loopback is reachable by other local accounts too, so the office (like the worker's
 * token) assumes a machine whose accounts you trust; it is not a defence against them.
 *
 * A cookie was the other option. Cookies are scoped by host, not port, so a cookie set for
 * 127.0.0.1 would ride along with requests from a page on any other local port; a token held in the
 * page's memory, handed only to its own origin, keeps the port boundary.
 */
export const DEFAULT_CLIENT_TOKEN_PATH = join(homedir(), '.orca-office', 'client-token');

/** The subprotocol the page asks for; the bridge answers with it. */
export const CLIENT_PROTOCOL = 'orca-office';
const TOKEN_PREFIX = 'token.';

function readToken(path: string): string | null {
  try {
    const t = readFileSync(path, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * The token, made on first use. Vite and the bridge both call this and may start at the same time,
 * so the file is created exclusively (`wx`) and whoever loses the race reads the winner's.
 */
export function loadOrCreateClientToken(path = DEFAULT_CLIENT_TOKEN_PATH): string {
  const found = readToken(path);
  if (found) {
    chmodSync(path, 0o600);
    return found;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  try {
    writeFileSync(path, token + '\n', { mode: 0o600, flag: 'wx' });
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const theirs = readToken(path);
    if (theirs) return theirs;
    // There, but not a token (an empty or broken file): replace it.
    writeFileSync(path, token + '\n', { mode: 0o600 });
    return token;
  }
}

/** The token a `Sec-WebSocket-Protocol` header carries, if it asks for the office protocol. */
export function tokenFromProtocols(header: string | string[] | undefined): string | null {
  const list = (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',').map((s) => s.trim());
  if (!list.includes(CLIENT_PROTOCOL)) return null;
  const t = list.find((s) => s.startsWith(TOKEN_PREFIX))?.slice(TOKEN_PREFIX.length);
  return t && /^[0-9a-f]{64}$/.test(t) ? t : null;
}

/** Whether an upgrade to `/client` presents the page's token. */
export function clientAuthorized(expected: string, header: string | string[] | undefined): boolean {
  return tokenMatches(expected, tokenFromProtocols(header));
}

export interface TokenRequest {
  host: string | undefined;
  origin: string | undefined;
  fetchSite: string | undefined;
}

/**
 * Whether the page's server may hand the token to this request (see above). `clientPort` is the
 * office page's port: Host and Origin must be it, on 127.0.0.1 or localhost.
 */
export function mayHaveToken(req: TokenRequest, clientPort: number): boolean {
  const hosts = new Set([`127.0.0.1:${clientPort}`, `localhost:${clientPort}`]);
  if (!req.host || !hosts.has(req.host)) return false;
  if (req.fetchSite !== 'same-origin') return false;
  // Same-origin fetches with GET may leave Origin out; when it's there it must be the page.
  return req.origin === undefined || req.origin === `http://${req.host}`;
}
