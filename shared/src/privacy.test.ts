import { describe, expect, it } from 'vitest';
import { BUBBLE_MAX_CHARS, redactForLog, toBubble } from './privacy.js';

describe('toBubble', () => {
  it('returns null for empty input', () => {
    expect(toBubble(null)).toBeNull();
    expect(toBubble('')).toBeNull();
    expect(toBubble('  \n\t ')).toBeNull();
  });

  it('collapses whitespace to one line', () => {
    expect(toBubble('hello\n\n  world')).toBe('hello world');
  });

  it('truncates to the limit with an ellipsis', () => {
    const out = toBubble('a'.repeat(500))!;
    expect(Array.from(out)).toHaveLength(BUBBLE_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not split astral characters', () => {
    expect(toBubble('😀'.repeat(200), 10)).toBe('😀'.repeat(9) + '…');
  });
});

describe('redactForLog', () => {
  it('removes private fields at any depth and keeps the rest', () => {
    const out = redactForLog({
      state: 'working',
      agents: [{ title: 'fix tests', lastAssistantMessage: 'secret plan', input: { path: '/x' } }],
    });
    expect(out).toEqual({
      state: 'working',
      agents: [{ title: '[redacted 9 chars]', lastAssistantMessage: '[redacted 11 chars]', input: '[redacted object]' }],
    });
  });

  it('leaves null private fields alone', () => {
    expect(redactForLog({ preview: null })).toEqual({ preview: null });
  });

  it('never returns the original text', () => {
    const secret = 'do not leak this';
    expect(JSON.stringify(redactForLog({ a: { b: { message: secret } } }))).not.toContain(secret);
  });
});
