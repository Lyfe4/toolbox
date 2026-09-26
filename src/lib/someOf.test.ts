import { describe, expect, it } from 'vitest';

import { SOME_OF_LIMIT, someOf } from './someOf';

describe('someOf', () => {
  it('names every item when there are no more than five', () => {
    expect(someOf(['a'])).toBe('a');
    expect(someOf(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, d, e');
  });

  // The count is the half that stops a cut-short list reading as complete.
  it('names five and counts the rest', () => {
    expect(someOf(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d, e, and 2 more');
    expect(SOME_OF_LIMIT).toBe(5);
  });

  it('joins the count with the same separator as the items', () => {
    expect(someOf(['x on <a>, <b>', 'y', 'z'], '; ', 2)).toBe('x on <a>, <b>; y; and 1 more');
  });

  it('says nothing for nothing', () => {
    expect(someOf([])).toBe('');
  });
});
