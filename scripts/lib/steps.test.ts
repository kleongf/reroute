import { describe, expect, it } from 'vitest';
import { parseExploreArgs, stepsFileSchema } from './steps.ts';

describe('parseExploreArgs', () => {
  it('defaults to headless with no steps', () => {
    expect(parseExploreArgs([])).toEqual({
      headed: false,
      help: false,
      url: undefined,
      stepsFile: undefined,
      cliSteps: [],
    });
  });

  it('keeps CLI steps in the order given and strips a leading --', () => {
    const opts = parseExploreArgs([
      '--',
      '--headed',
      '--click',
      '[data-testid=go]',
      '--fill',
      '#name::Alice::B',
      '--wait',
      '250',
      '--screenshot',
      'after-click',
    ]);
    expect(opts.headed).toBe(true);
    expect(opts.cliSteps).toEqual([
      { action: 'click', selector: '[data-testid=go]' },
      { action: 'fill', selector: '#name', value: 'Alice::B' },
      { action: 'wait', ms: 250 },
      { action: 'screenshot', name: 'after-click' },
    ]);
  });

  it('rejects malformed values', () => {
    expect(() => parseExploreArgs(['--fill', 'no-separator'])).toThrow(/--fill/);
    expect(() => parseExploreArgs(['--wait', 'soon'])).toThrow(/--wait/);
    expect(() => parseExploreArgs(['--screenshot', '../escape'])).toThrow();
    expect(() => parseExploreArgs(['--bogus'])).toThrow();
  });
});

describe('stepsFileSchema', () => {
  it('rejects unknown actions and extra keys', () => {
    expect(stepsFileSchema.safeParse([{ action: 'hover', selector: 'a' }]).success).toBe(false);
    expect(stepsFileSchema.safeParse([{ action: 'click', selector: 'a', x: 1 }]).success).toBe(
      false,
    );
    expect(stepsFileSchema.safeParse([{ action: 'wait', ms: 10 }]).success).toBe(true);
  });
});
