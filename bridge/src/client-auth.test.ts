import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { clientAuthorized, loadOrCreateClientToken, mayHaveToken, tokenFromProtocols } from './client-auth.js';

const dir = () => mkdtempSync(join(tmpdir(), 'orca-office-client-'));

test('the token is made once, 0600, and read back', () => {
  const path = join(dir(), 'sub', 'client-token');
  const a = loadOrCreateClientToken(path);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(loadOrCreateClientToken(path)).toBe(a);
  expect(readFileSync(path, 'utf8').trim()).toBe(a);
});

test('a broken token file is replaced', () => {
  const path = join(dir(), 'client-token');
  writeFileSync(path, 'nope\n');
  expect(loadOrCreateClientToken(path)).toMatch(/^[0-9a-f]{64}$/);
});

test('the token comes only from the office subprotocol', () => {
  const t = 'a'.repeat(64);
  expect(tokenFromProtocols(`orca-office, token.${t}`)).toBe(t);
  expect(tokenFromProtocols([`orca-office`, `token.${t}`])).toBe(t);
  expect(tokenFromProtocols(`token.${t}`)).toBeNull();
  expect(tokenFromProtocols('orca-office, token.short')).toBeNull();
  expect(tokenFromProtocols(undefined)).toBeNull();
  expect(clientAuthorized(t, `orca-office, token.${t}`)).toBe(true);
  expect(clientAuthorized(t, `orca-office, token.${'b'.repeat(64)}`)).toBe(false);
  expect(clientAuthorized(t, 'orca-office')).toBe(false);
});

test('only a same-origin fetch from the office page gets the token', () => {
  const ok = { host: '127.0.0.1:5317', origin: undefined, fetchSite: 'same-origin' };
  expect(mayHaveToken(ok, 5317)).toBe(true);
  expect(mayHaveToken({ ...ok, host: 'localhost:5317', origin: 'http://localhost:5317' }, 5317)).toBe(true);
  // Another site, another local port, a frame or curl (no Sec-Fetch-Site), DNS rebinding.
  expect(mayHaveToken({ ...ok, fetchSite: 'cross-site', origin: 'https://evil.example' }, 5317)).toBe(false);
  expect(mayHaveToken({ ...ok, fetchSite: 'same-site', origin: 'http://127.0.0.1:3000' }, 5317)).toBe(false);
  expect(mayHaveToken({ ...ok, fetchSite: undefined }, 5317)).toBe(false);
  expect(mayHaveToken({ ...ok, host: 'evil.example:5317' }, 5317)).toBe(false);
  expect(mayHaveToken({ ...ok, origin: 'http://127.0.0.1:3000' }, 5317)).toBe(false);
  expect(mayHaveToken(ok, 5417)).toBe(false);
});
