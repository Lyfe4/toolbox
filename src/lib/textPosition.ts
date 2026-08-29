import type { SourcePosition } from '@/features/registry/types';

/**
 * Converts a character offset into a 1-based line and column.
 *
 * Parsers report failures at wildly different granularities - a character
 * index, a line/column pair, or nothing at all. Everything is normalised
 * through here so the UI has exactly one shape to render.
 *
 * Newline handling counts a lone "\n" and a "\r\n" pair as one line break, so
 * a CRLF file does not report columns that are one too high.
 */
export function positionFromOffset(source: string, offset: number): SourcePosition {
  const clamped = Math.max(0, Math.min(offset, source.length));

  let line = 1;
  let lineStart = 0;

  for (let index = 0; index < clamped; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      lineStart = index + 1;
    }
  }

  // A CR immediately before the offset belongs to the break, not the column.
  const column = clamped - lineStart + 1;

  return { line, column, offset: clamped };
}

/** Builds a position directly from a parser that already reports line/column. */
export function positionFromLineColumn(
  line: number,
  column: number,
  offset: number | null = null,
): SourcePosition {
  return { line: Math.max(1, line), column: Math.max(1, column), offset };
}

/** The UTF-8 byte order mark, as it appears once decoded to a string. */
export const BOM = '﻿';

/** Strips a leading BOM. Parsers otherwise see it as content and fail. */
export function stripBom(source: string): string {
  return source.startsWith(BOM) ? source.slice(1) : source;
}
