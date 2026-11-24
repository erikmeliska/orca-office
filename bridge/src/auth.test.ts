import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostAllowed, loadOrCreateToken, tokenMatches } from './auth.js';

describe('token', () => {
  it('creates a 0600 token once and reuses it', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'oo-')), 'sub', 'token');
    const t = loadOrCreateToken(path);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadOrCreateToken(path)).toBe(t);
    expect(readFileSync(path, 'utf8').trim()).toBe(t);
  });
  it('compares tokens', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abd')).toBe(false);
    expect(tokenMatches('abc', 'ab')).toBe(false);
    expect(tokenMatches('abc', null)).toBe(false);
  });
});

describe('hostAllowed', () => {
  it('accepts loopback names only', () => {
    expect(hostAllowed('127.0.0.1:4317', 4317)).toBe(true);
    expect(hostAllowed('localhost:4317', 4317)).toBe(true);
    expect(hostAllowed('evil.example:4317', 4317)).toBe(false);
    expect(hostAllowed(undefined, 4317)).toBe(false);
  });
});
