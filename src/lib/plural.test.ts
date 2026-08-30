import { describe, expect, it } from 'vitest';

import { counted, plural } from './plural';

describe('plural', () => {
  it.each([
    [0, 'wires'],
    [1, 'wire'],
    [2, 'wires'],
    [17, 'wires'],
  ])('gives %i the form %s', (count, expected) => {
    expect(plural(count, 'wire')).toBe(expected);
  });

  it('takes an irregular plural when the -s rule would be wrong', () => {
    expect(plural(1, 'entry', 'entries')).toBe('entry');
    expect(plural(3, 'entry', 'entries')).toBe('entries');
  });

  it('does not treat a negative count as singular', () => {
    // Not reachable from the UI, but "-1 wire" would be a strange thing to
    // print if a count ever went wrong upstream.
    expect(plural(-1, 'wire')).toBe('wires');
  });
});

describe('counted', () => {
  it.each([
    [0, '0 wires'],
    [1, '1 wire'],
    [2, '2 wires'],
  ])('renders %i as %s', (count, expected) => {
    expect(counted(count, 'wire')).toBe(expected);
  });

  // The one that shipped: the status bar read "1 WIRES".
  it('never says "1 wires"', () => {
    expect(counted(1, 'wire')).not.toContain('wires');
  });
});
