import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults to loopback and the default port', () => {
    expect(loadConfig({})).toEqual({ host: '127.0.0.1', port: DEFAULT_PORT, clientPort: 5317, stub: false });
  });
  it('reads ORCA_OFFICE_PORT', () => {
    expect(loadConfig({ ORCA_OFFICE_PORT: '5000' }).port).toBe(5000);
  });
  it('turns stub mode on only for ORCA_OFFICE_STUB=1', () => {
    expect(loadConfig({ ORCA_OFFICE_STUB: '1' }).stub).toBe(true);
    expect(loadConfig({ ORCA_OFFICE_STUB: 'yes' }).stub).toBe(false);
  });
  it('rejects an invalid port', () => {
    expect(() => loadConfig({ ORCA_OFFICE_PORT: 'abc' })).toThrow();
    expect(() => loadConfig({ ORCA_OFFICE_PORT: '70000' })).toThrow();
  });
});
