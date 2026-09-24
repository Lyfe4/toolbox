import { describe, expect, it } from 'vitest';

import { positionFromOffset } from './textPosition';

/**
 * THE HEADER'S PROMISE, HELD: a CRLF file reports the same line and column as
 * the LF file with the same characters in it.
 *
 * This file did not exist until round seventeen. The function's comment said
 * "a CR immediately before the offset belongs to the break, not the column"
 * above a line that did no such thing, so an offset on the LF of a CRLF pair -
 * the end of a line, where "unexpected end of line" errors point - came out a
 * column further right than the same error in an LF file.
 */
describe('positionFromOffset', () => {
  const LF = 'ab\ncde\nf';
  const CRLF = 'ab\r\ncde\r\nf';

  it('puts the same character at the same line and column in both', () => {
    // `d`, the second character of the second line.
    expect(positionFromOffset(LF, LF.indexOf('d'))).toEqual({ line: 2, column: 2, offset: 4 });
    expect(positionFromOffset(CRLF, CRLF.indexOf('d'))).toEqual({ line: 2, column: 2, offset: 5 });
  });

  it('puts the end of a line at the same column whether it ends in LF or CRLF', () => {
    const lf = positionFromOffset(LF, LF.indexOf('\n', 3));
    const crlf = positionFromOffset(CRLF, CRLF.indexOf('\n', 4));
    expect(lf).toMatchObject({ line: 2, column: 4 });
    expect(crlf).toMatchObject({ line: 2, column: 4 });
  });

  it('counts a CR that is not before a line feed as a character like any other', () => {
    expect(positionFromOffset('a\rb', 2)).toMatchObject({ line: 1, column: 3 });
  });

  it('starts from the line a caller says it has already consumed', () => {
    expect(positionFromOffset('x\ny', 2, 2)).toMatchObject({ line: 3, column: 1 });
  });
});
