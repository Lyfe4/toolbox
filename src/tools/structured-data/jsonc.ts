/**
 * JSON WITH COMMENTS, AS A STEP OF ITS OWN.
 *
 * `tsconfig.json`, every VS Code settings file, and most JSON an LLM writes is
 * not JSON: it has `//` comments, `/* *\/` comments, and a comma before the
 * closing brace. Round two made all three report the JSON parser's own error,
 * which was an improvement on what came before - the YAML fallback used to fold
 * the comment and the key after it into ONE KEY, `// a comment "a"`, and call
 * it success - but it is still a refusal of a document whose meaning is not in
 * doubt.
 *
 * So this is the step between JSON and the YAML fallback: remove what JSONC
 * allows and JSON does not, then hand the result to `JSON.parse`. Two
 * properties make it safe to put in front of YAML rather than behind it:
 *
 *   1. IT IS STRING-AWARE. A `//` inside a string literal is four characters of
 *      a URL, not a comment, and a `/*` inside one is not the start of
 *      anything. This is the whole reason the job cannot be done with a regular
 *      expression, and the whole reason the YAML fallback was the wrong place
 *      for it: nothing here can fold a comment into a key, because a comment is
 *      removed as a comment or not at all.
 *
 *   2. IT PRESERVES OFFSETS. Everything removed is replaced by a space of the
 *      same length, and a line break inside a block comment is kept as a line
 *      break. So when the stripped text still does not parse, `JSON.parse`'s
 *      line and column point at the same character of the document the user is
 *      looking at. A stripper that shortened the text would move every error
 *      after the first comment.
 *
 * WHAT IT DOES NOT DO. Single quotes, unquoted keys and a literal newline
 * inside a string are not JSONC - JSON5 and YAML allow them, JSONC does not -
 * and they still go to the YAML fallback and the `foldsLines` guard behind it.
 * The two steps have different jobs and this one does not guess.
 */

export interface JsoncStripped {
  /** The source with comments and trailing commas blanked out, same length. */
  readonly text: string;
  readonly lineComments: number;
  readonly blockComments: number;
  readonly trailingCommas: number;
  /** True when anything at all was removed. */
  readonly changed: boolean;
}

/**
 * Walks a JSON-ish document, blanking comments and trailing commas.
 *
 * One pass, because the two jobs are not independent: `[1, /* x *\/ ]` has a
 * trailing comma only once the comment between it and the bracket is gone, and
 * a two-pass version would have to re-scan strings a second time to find out.
 * The comma is therefore remembered rather than written, and blanked when the
 * next significant character turns out to be a closing bracket.
 */
export function stripJsonc(source: string): JsoncStripped {
  const out = source.split('');
  let lineComments = 0;
  let blockComments = 0;
  let trailingCommas = 0;

  /** Where the most recent comma outside a string was, if nothing followed it. */
  let pendingComma: number | null = null;

  let index = 0;
  while (index < source.length) {
    const char = source[index];

    if (char === '"') {
      // A string literal, skipped whole. `\\"` is an escaped quote and does not
      // close it; `\\\\` is an escaped backslash and the quote after it does.
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        if (inner === '\\') {
          index += 2;
          continue;
        }
        index += 1;
        if (inner === '"') break;
      }
      pendingComma = null;
      continue;
    }

    if (char === '/' && source[index + 1] === '/') {
      lineComments += 1;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        out[index] = ' ';
        index += 1;
      }
      continue;
    }

    if (char === '/' && source[index + 1] === '*') {
      blockComments += 1;
      const end = source.indexOf('*/', index + 2);
      // An unterminated block comment runs to the end of the document. Blanking
      // it rather than giving up means `JSON.parse` reports the real problem -
      // a document that stops in the middle - instead of a stray `/`.
      const stop = end === -1 ? source.length : end + 2;
      while (index < stop) {
        // Line breaks survive, so a line number counted after this comment is
        // the line number the user sees.
        if (source[index] !== '\n' && source[index] !== '\r') out[index] = ' ';
        index += 1;
      }
      continue;
    }

    if (char === ',') {
      pendingComma = index;
      index += 1;
      continue;
    }

    if (char === '}' || char === ']') {
      if (pendingComma !== null) {
        out[pendingComma] = ' ';
        trailingCommas += 1;
      }
      pendingComma = null;
      index += 1;
      continue;
    }

    // Whitespace does not end a pending comma; anything else does.
    if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') pendingComma = null;
    index += 1;
  }

  return {
    text: out.join(''),
    lineComments,
    blockComments,
    trailingCommas,
    changed: lineComments + blockComments + trailingCommas > 0,
  };
}

/** What was removed, as a sentence. Null when nothing was. */
export function describeJsonc(stripped: JsoncStripped): string | null {
  const parts: string[] = [];
  const comments = stripped.lineComments + stripped.blockComments;
  if (comments > 0) parts.push(`${comments.toString()} comment${comments === 1 ? '' : 's'}`);
  if (stripped.trailingCommas > 0) {
    const count = stripped.trailingCommas;
    parts.push(`${count.toString()} trailing comma${count === 1 ? '' : 's'}`);
  }
  return parts.length === 0 ? null : parts.join(' and ');
}
