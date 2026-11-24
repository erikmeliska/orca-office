import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, isHello } from './protocol.js';

describe('isHello', () => {
  it('accepts a valid hello', () => {
    expect(isHello({ type: 'hello', role: 'plugin', protocol: PROTOCOL_VERSION })).toBe(true);
  });
  it('rejects other shapes', () => {
    expect(isHello(null)).toBe(false);
    expect(isHello({ type: 'hello', role: 'admin', protocol: 0 })).toBe(false);
    expect(isHello({ type: 'hello', role: 'client' })).toBe(false);
  });
});
