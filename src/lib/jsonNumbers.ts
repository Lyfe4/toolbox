/**
 * INTEGERS A DOUBLE CANNOT HOLD, FOUND IN THE SOURCE AND NAMED BY PATH.
 *
 * `{"id": 12345678901234567890}` parses to `12345678901234567000`. JSON's
 * grammar puts no limit on a number's digits and JavaScript has one numeric
 * type, so `JSON.parse` rounds and every port downstream carries the rounded
 * value: a 64-bit database key, a Discord or Twitter snowflake, a nanosecond
 * timestamp. The loss is unavoidable in a JavaScript program. Being told about
 * it is not, and that is the whole of what this file is for.
 *
 * WHY THE SOURCE AND NOT THE PARSED VALUE. The obvious implementation walks the
 * result and reports every integer for which `Number.isSafeInteger` is false,
 * and it is WRONG - `9007199254740994` is 2^53 + 2, which no `isSafeInteger`
 * accepts and which a double holds exactly. A report that names a number that
 * was not rounded is the same class of confident wrongness this whole round
 * exists to remove, so the question is asked of the literal the author wrote:
 *
 *     BigInt(literal) !== BigInt(Number(literal))
 *
 * which is exact, decides every integer literal, and needs nothing but the two
 * built-ins. Non-integer literals are deliberately out of scope: `0.1` is not
 * exactly representable either, everyone already knows it, and warning about
 * every decimal in a document is the note that trains people to ignore notes.
 *
 * WHY A SCANNER AND NOT A REVIVER. `JSON.parse`'s reviver visits children
 * before their parents and is handed no path, and the source-text access that
 * would make it work is too new to rely on in the two engines
 * `check:browsers` drives. A scanner over a document `JSON.parse` has ALREADY
 * ACCEPTED is a much smaller job than a parser: it never has to decide whether
 * the document is valid, only where it is.
 */

export interface RoundedNumber {
  /** JSONPath-ish: `$.users[2].id`. The same spelling the refusals use. */
  readonly path: string;
  /** The digits the author wrote. */
  readonly source: string;
  /** What a double made of them. */
  readonly value: number;
}

/**
 * A cheap gate before the scan.
 *
 * 2^53 is 9007199254740992 - sixteen digits - so every integer of fifteen
 * digits or fewer survives exactly and no document without a run of sixteen
 * digits can contain one that does not. This is what keeps a 16 MB document
 * that has no such number from being walked a second time for nothing.
 */
const LONG_RUN = /\d{16,}/;

/** Whether a literal is an integer written in full, rather than `1e300`. */
const PLAIN_INTEGER = /^-?\d+$/;

/** True when the literal denotes something other than the double it parses to. */
export function isRounded(literal: string): boolean {
  if (!PLAIN_INTEGER.test(literal)) return false;
  const value = Number(literal);
  if (!Number.isFinite(value)) return true;
  // `BigInt` of a non-integer double throws, and a literal of this shape can
  // only produce a non-integer by overflowing to Infinity, which is caught
  // above. Both sides are therefore exact integers and the comparison is too.
  return BigInt(literal) !== BigInt(value);
}

/**
 * Every rounded integer in a JSON document, by path.
 *
 * The document must already have been accepted by `JSON.parse`; this walks it
 * for positions rather than validating it. A malformed document simply yields
 * whatever it found before running out, which is why nothing here throws.
 */
export function roundedNumbersInJson(source: string): readonly RoundedNumber[] {
  if (!LONG_RUN.test(source)) return [];

  const found: RoundedNumber[] = [];
  /** The path to the value currently being read, as segments to join. */
  const stack: string[] = [];
  let index = 0;

  const skipSpace = (): void => {
    while (index < source.length) {
      const char = source[index];
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r') index += 1;
      else break;
    }
  };

  /** Reads a string literal, returning its contents with escapes resolved. */
  const readString = (): string => {
    const start = index;
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      index += 1;
      if (char === '"') break;
    }
    try {
      // The document parsed, so the slice is a valid JSON string literal and
      // this resolves `é` and friends to the key the path should print.
      return JSON.parse(source.slice(start, index)) as string;
    } catch {
      return source.slice(start + 1, Math.max(start + 1, index - 1));
    }
  };

  const readValue = (): void => {
    skipSpace();
    const char = source[index];
    if (char === undefined) return;

    if (char === '{') {
      index += 1;
      for (;;) {
        skipSpace();
        if (source[index] === '}' || index >= source.length) {
          index += 1;
          return;
        }
        if (source[index] === ',') {
          index += 1;
          continue;
        }
        if (source[index] !== '"') {
          /*
           * Not a key where one belongs, which cannot happen for a document
           * `JSON.parse` has already accepted. The character is skipped rather
           * than guessed at, and `index` always advances so this cannot spin -
           * the worst it can do on a document that is not what it was told it
           * was is find fewer numbers than there are, which is the direction to
           * be wrong in.
           */
          index += 1;
          continue;
        }
        const key = readString();
        skipSpace();
        if (source[index] === ':') index += 1;
        // A key that is not a bare identifier is printed in brackets, which is
        // the spelling `toJsonValue`'s refusals already use for awkward keys.
        stack.push(/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);
        readValue();
        stack.pop();
      }
    }

    if (char === '[') {
      index += 1;
      let position = 0;
      for (;;) {
        skipSpace();
        if (source[index] === ']' || index >= source.length) {
          index += 1;
          return;
        }
        if (source[index] === ',') {
          index += 1;
          continue;
        }
        stack.push(`[${position.toString()}]`);
        readValue();
        stack.pop();
        position += 1;
      }
    }

    if (char === '"') {
      readString();
      return;
    }

    // A literal: a number, or true/false/null. Read to the next structural
    // character, which is what ends any of them.
    const start = index;
    while (index < source.length) {
      const next = source[index];
      if (
        next === ',' ||
        next === '}' ||
        next === ']' ||
        next === ' ' ||
        next === '\t' ||
        next === '\n' ||
        next === '\r'
      ) {
        break;
      }
      index += 1;
    }
    const literal = source.slice(start, index);
    if (isRounded(literal)) {
      found.push({ path: `$${stack.join('')}`, source: literal, value: Number(literal) });
    }
  };

  readValue();
  return found;
}
