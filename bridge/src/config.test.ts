import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults to loopback and the default port', () => {
    expect(loadConfig({})).toEqual({ host: '127.0.0.1', port: DEFAULT_PORT, clientPort: 5317 });
  });
  it('reads ORCA_OFFICE_PORT', () => {
    expect(loadConfig({ ORCA_OFFICE_PORT: '5000' }).port).toBe(5000);
  });
  it('rejects an invalid port', () => {
    expect(() => loadConfig({ ORCA_OFFICE_PORT: 'abc' })).toThrow();
    expect(() => loadConfig({ ORCA_OFFICE_PORT: '70000' })).toThrow();
  });
});
