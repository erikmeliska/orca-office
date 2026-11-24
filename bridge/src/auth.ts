import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Shared secret between the Orca worker and the bridge. Loopback is reachable
 * by every local process and user, so the plugin proves itself with a token
 * from a file only this user can read (0600 in a 0700 folder).
 */
export const DEFAULT_TOKEN_PATH = join(homedir(), '.orca-office', 'token');

export function loadOrCreateToken(path = DEFAULT_TOKEN_PATH): string {
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (token.length >= 32) {
      chmodSync(path, 0o600);
      return token;
    }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  return token;
}

export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Blocks DNS rebinding: only loopback names are accepted as Host. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
