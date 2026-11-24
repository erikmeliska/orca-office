import { describe, expect, it } from 'vitest';
import { httpsUrl } from './links';

describe('httpsUrl', () => {
  it('keeps plain https', () => {
    expect(httpsUrl('https://github.com/a/b/pull/1')).toBe('https://github.com/a/b/pull/1');
  });
  it('drops other schemes and credentials', () => {
    expect(httpsUrl('javascript:alert(1)')).toBeUndefined();
    expect(httpsUrl('JAVASCRIPT:alert(1)')).toBeUndefined();
    expect(httpsUrl('data:text/html,x')).toBeUndefined();
    expect(httpsUrl('http://example.com')).toBeUndefined();
    expect(httpsUrl('https://user:pw@example.com')).toBeUndefined();
    expect(httpsUrl('not a url')).toBeUndefined();
    expect(httpsUrl(undefined)).toBeUndefined();
  });
});
