import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { allowedClientOrigins, checkUpgrade } from './origin.js';
import { distReady, resolveStatic } from './static.js';

function dist() {
  const root = mkdtempSync(join(tmpdir(), 'orca-office-dist-'));
  const d = join(root, 'dist');
  mkdirSync(join(d, 'assets'), { recursive: true });
  writeFileSync(join(d, 'index.html'), '<!doctype html>');
  writeFileSync(join(d, 'assets', 'main-abc.js'), 'x');
  writeFileSync(join(root, 'secret.txt'), 'no');
  symlinkSync(join(root, 'secret.txt'), join(d, 'link.txt'));
  return { root, d };
}

test('serves only files inside dist', () => {
  const { d } = dist();
  expect(resolveStatic(d, '/')).toMatchObject({ type: 'text/html; charset=utf-8', immutable: false });
  expect(resolveStatic(d, '/index.html?v=1')?.path.endsWith('index.html')).toBe(true);
  expect(resolveStatic(d, '/assets/main-abc.js')).toMatchObject({ type: 'text/javascript; charset=utf-8', immutable: true });
  for (const bad of ['/../secret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets%5c..%5c..%5csecret.txt', '/index.html%00.js', '/link.txt', '/nope.js', 'index.html', '/%E0%A4%A', '/assets/']) {
    expect([bad, resolveStatic(d, bad)]).toEqual([bad, null]);
  }
  expect(distReady(d)).toBe(true);
  expect(distReady(join(d, 'assets'))).toBe(false);
});

test('the built page on the bridge port may open /client', () => {
  const origins = allowedClientOrigins(5317, 4317);
  expect(checkUpgrade('/client', 'http://127.0.0.1:4317', origins)).toBe('client');
  expect(checkUpgrade('/client', 'http://localhost:4317', origins)).toBe('client');
  expect(checkUpgrade('/client', 'http://127.0.0.1:5317', origins)).toBe('client');
  expect(checkUpgrade('/client', 'http://127.0.0.1:4318', origins)).toBeNull();
  expect(checkUpgrade('/plugin', 'http://127.0.0.1:4317', origins)).toBeNull();
});
