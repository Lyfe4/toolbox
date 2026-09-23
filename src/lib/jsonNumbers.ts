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
 *
 * AND A SECOND QUESTION, ASKED OF THE SAME WALK. Round twelve needed duplicate
 * OBJECT KEYS - `{"retries": 3, "retries": 5}` is valid JSON that every reader
 * resolves last-wins, so the 3 is gone before this tool is handed anything -
 * and a reviver cannot see one either, for a sharper reason: the object is
 * built before the reviver runs, so the duplicate has already been resolved.
 * The second scanner that would have answered it is not here. One walk answers
 * both, because the thing the two have to agree about is the path spelling,
 * and two walks would be two spellings a document could tell apart.
 *
 * The file is still called `jsonNumbers` because the round that added the
 * second question decided a rename was not worth rewriting the round-eleven
 * write-up that names it.
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

/** A key written twice in one object, and the value that lost. */
export interface DuplicateKey {
  /** JSONPath-ish to the key: the same spelling `RoundedNumber.path` uses. */
  readonly path: string;
  /** The key, as the author wrote it. */
  readonly key: string;
  /** The literal that was discarded, as the author wrote it, clipped. */
  readonly discarded: string;
}

export interface JsonSourceScan {
  readonly rounded: readonly RoundedNumber[];
  readonly duplicates: readonly DuplicateKey[];
}

/**
 * How much of a discarded value to quote.
 *
 * The point of quoting it at all is that the reader can tell which of the two
 * values they lost. A whole discarded object would put a document inside a
 * note, so it is clipped - and clipped visibly, because a silently truncated
 * value would be a third value neither of the two in the file.
 */
const DISCARDED_LIMIT = 60;

function clipLiteral(literal: string): string {
  const tidy = literal.trim().replace(/\s+/gu, ' ');
  return tidy.length <= DISCARDED_LIMIT ? tidy : `${tidy.slice(0, DISCARDED_LIMIT)}…`;
}

/**
 * Every rounded integer in a JSON document, by path.
 *
 * The gate is here rather than inside the walk because this is the entry point
 * for callers that want nothing else - `jwt-decode`'s payload read is one -
 * and for them a document with no sixteen-digit run costs one regular
 * expression rather than a walk.
 */
export function roundedNumbersInJson(source: string): readonly RoundedNumber[] {
  if (!LONG_RUN.test(source)) return [];
  return scanJsonSource(source, { numbers: true }).rounded;
}

/**
 * Every key written twice in one object, by path, with the value that lost.
 *
 * NO CHEAP GATE, AND THAT IS NOT AN OVERSIGHT. The rounded-integer scan has
 * one because sixteen consecutive digits is a property of the TEXT that a
 * regular expression settles in one pass; "the same key twice in one object"
 * is a property of the STRUCTURE, and deciding it needs the walk that finds
 * it.
 *
 * SO IT IS NOT CHEAP, AND THE NUMBER IS HERE RATHER THAN THE WORD. Measured on
 * an 11.7 MB document: ~200 ms, against `JSON.parse`'s ~40-55 ms on the same
 * bytes. That is four to five times the parse, accepted on a tool with a 15 s
 * budget and a 16 MB ceiling, because the alternative is a size above which
 * the note silently stops firing. Short-circuiting the `JSON.parse` in
 * `readString` for keys with no escapes was tried and moved nothing - the cost
 * is the per-character loop. See docs/test-findings.md.
 */
export function duplicateJsonKeys(source: string): readonly DuplicateKey[] {
  return scanJsonSource(source, { numbers: false }).duplicates;
}

/**
 * One walk, both questions.
 *
 * The document must already have been accepted by `JSON.parse`; this walks it
 * for positions rather than validating it. A malformed document simply yields
 * whatever it found before running out, which is why nothing here throws.
 *
 * `numbers` is the rounded-integer gate, threaded in rather than re-tested:
 * the caller that wants both facts has already run the regular expression, and
 * running it again would be the second copy of a decision.
 */
export function scanJsonSource(
  source: string,
  options: { readonly numbers: boolean },
): JsonSourceScan {
  const found: RoundedNumber[] = [];
  const duplicates: DuplicateKey[] = [];
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
      /** Keys seen in THIS object, with the extent of the value each named. */
      let keys: Map<string, { readonly start: number; readonly end: number }> | null = null;
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
        /*
         * The value's own extent, so a duplicate can quote the literal that
         * lost. `skipSpace` first, or the slice opens with the whitespace
         * after the colon; `readValue` skips it again and does not mind.
         */
        skipSpace();
        const valueStart = index;
        readValue();

        /*
         * Lazily, and only for this object. A Map per object is the cost of
         * the question; allocating one for the objects that never get a second
         * key is not, and a document of sixty thousand small records is the
         * shape this runs on.
         */
        const previous = keys?.get(key);
        if (previous !== undefined) {
          duplicates.push({
            path: `$${stack.join('')}`,
            key,
            discarded: clipLiteral(source.slice(previous.start, previous.end)),
          });
        }
        keys ??= new Map();
        keys.set(key, { start: valueStart, end: index });

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
    if (!options.numbers) return;
    const literal = source.slice(start, index);
    if (isRounded(literal)) {
      found.push({ path: `$${stack.join('')}`, source: literal, value: Number(literal) });
    }
  };

  readValue();
  return { rounded: found, duplicates };
}
