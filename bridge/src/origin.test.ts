import { describe, expect, it } from 'vitest';
import { allowedClientOrigins, checkUpgrade } from './origin.js';

const origins = allowedClientOrigins(5317);

describe('checkUpgrade', () => {
  it('accepts the plugin without an Origin', () => {
    expect(checkUpgrade('/plugin', undefined, origins)).toBe('plugin');
  });
  it('refuses a browser posing as the plugin', () => {
    expect(checkUpgrade('/plugin', 'https://evil.example', origins)).toBeNull();
    expect(checkUpgrade('/plugin', 'http://127.0.0.1:5317', origins)).toBeNull();
  });
  it('accepts the office page as a client', () => {
    expect(checkUpgrade('/client', 'http://127.0.0.1:5317', origins)).toBe('client');
    expect(checkUpgrade('/client?x=1', 'http://localhost:5317', origins)).toBe('client');
  });
  it('refuses other origins and paths', () => {
    expect(checkUpgrade('/client', 'https://evil.example', origins)).toBeNull();
    expect(checkUpgrade('/client', undefined, origins)).toBeNull();
    expect(checkUpgrade('/other', undefined, origins)).toBeNull();
  });
});
