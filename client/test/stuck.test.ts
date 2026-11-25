import { describe, expect, it } from 'vitest';
import { isStuck, span, stuckText, stuckWhy } from '@orca-office/shared/office/stuck';

const MIN = 60_000;
const H = 60 * MIN;

describe('stuck (M7 B5)', () => {
  it('a working agent Orca has been quiet about for 15 min looks stuck', () => {
    expect(stuckWhy({ status: 'working', quietSince: 0, workingSince: 0 }, 14 * MIN)).toBeNull();
    expect(stuckWhy({ status: 'working', quietSince: 0, workingSince: 0 }, 15 * MIN)).toBe('quiet');
  });

  it('one working for hours looks stuck even if Orca keeps talking', () => {
    expect(stuckWhy({ status: 'working', quietSince: 26 * H - MIN, workingSince: 0 }, 26 * H)).toBe('long');
    expect(stuckText({ status: 'working', quietSince: 26 * H - MIN, workingSince: 0 }, 26 * H)).toBe('working for 1 d 2 h');
  });

  it('only working agents, and the rule can be changed', () => {
    expect(isStuck({ status: 'needs_input', quietSince: 0 }, 10 * H)).toBe(false);
    expect(isStuck({ status: 'done', workingSince: 0 }, 10 * H)).toBe(false);
    expect(isStuck({ status: 'working', quietSince: 0 }, 6 * MIN, { quietMin: 5, longHours: 4 })).toBe(true);
    expect(isStuck({ status: 'working' }, 100 * H)).toBe(false);
  });

  it('spans read short', () => {
    expect(span(22 * MIN)).toBe('22 min');
    expect(span(3 * H + 5 * MIN)).toBe('3 h 05 min');
  });
});
