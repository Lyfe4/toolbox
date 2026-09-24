/**
 * WHERE A JSON DOCUMENT STOPS BEING JSON, FOUND WITHOUT ASKING THE ENGINE.
 *
 * The structured-data tool used to read a syntax error's position out of the
 * message `JSON.parse` threw, and an engine's message is not a contract.
 * Measured in round sixteen on 2,165 refused documents
 * (`spec/json-syntax-oracle.json`): Gecko's message carries a line and column
 * every time, V8's 72% of the time, and JavaScriptCore's never. So a Safari
 * user was never told where their JSON was wrong, and a Chrome user was told
 * for `{"a": 1,}` and not for `[1, 2,]`. The one test for it passed because
 * its document produced V8's other message format.
 *
 * This reads the document against RFC 8259's grammar, which is small enough
 * to hold in one function, and returns the UTF-16 offset of the first place it
 * breaks. It runs only after `JSON.parse` has already refused the document, so
 * it never decides WHETHER something is JSON - the engine does that - only
 * where.
 *
 * WHICH PLACE. The first character that cannot continue a JSON text, with one
 * convention to choose: a misspelled keyword. `tru0` is wrong at the `t` if
 * the question is "which token", and at the `0` if it is "which character".
 * Gecko answers the first and V8 the second. This follows Gecko, for two
 * reasons: it is the engine that answers every case, so every case in the
 * oracle can hold this to an exact offset; and a caret under the start of the
 * word someone misspelled is the one they will recognise. Everywhere else the
 * two engines agree, and so does this - the test holds it to both.
 *
 * ITERATIVE ON PURPOSE. The document that reaches this may be refused for
 * being too deep rather than for its syntax, and a recursive reader would
 * then overflow the same stack the engine did.
 */

/** Null when the source is JSON as far as this grammar can tell. */
export function locateJsonSyntaxError(source: string): number | null {
  const length = source.length;
  let index = 0;

  /** What the reader is waiting for inside each open container. */
  type Awaiting =
    | 'value-or-close' // just after `[`
    | 'key-or-close' // just after `{`
    | 'key' // just after a `,` in an object
    | 'colon' // after a key
    | 'value' // after a `:` or a `,` in an array
    | 'comma-or-close'; // after a value
  const stack: { readonly closer: ']' | '}'; awaiting: Awaiting }[] = [];

  const skipSpace = (): void => {
    while (index < length) {
      const code = source.charCodeAt(index);
      // RFC 8259 §2: space, tab, line feed, carriage return. Nothing else -
      // a no-break space is an error, and the oracle has one.
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) index += 1;
      else return;
    }
  };

  const isDigit = (at: number): boolean => {
    const code = source.charCodeAt(at);
    return code >= 0x30 && code <= 0x39;
  };

  const isHex = (at: number): boolean => /[0-9a-fA-F]/.test(source[at] ?? '');

  /** Reads a string from its opening quote; returns the offset of a fault, or null. */
  const readString = (): number | null => {
    index += 1;
    while (index < length) {
      const code = source.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        return null;
      }
      if (code < 0x20) return index;
      if (code === 0x5c) {
        const escape = source[index + 1];
        if (escape === undefined) return length;
        if ('"\\/bfnrt'.includes(escape)) {
          index += 2;
          continue;
        }
        if (escape !== 'u') return index + 1;
        for (let digit = 2; digit < 6; digit += 1) {
          if (index + digit >= length) return length;
          if (!isHex(index + digit)) return index + digit;
        }
        index += 6;
        continue;
      }
      index += 1;
    }
    return length;
  };

  /** Reads a number from its first character; returns the offset of a fault, or null. */
  const readNumber = (): number | null => {
    if (source[index] === '-') index += 1;
    if (index >= length) return length;
    if (source[index] === '0') index += 1;
    else if (isDigit(index)) while (isDigit(index)) index += 1;
    else return index;
    if (source[index] === '.') {
      index += 1;
      if (index >= length) return length;
      if (!isDigit(index)) return index;
      while (isDigit(index)) index += 1;
    }
    if (source[index] === 'e' || source[index] === 'E') {
      index += 1;
      if (source[index] === '+' || source[index] === '-') index += 1;
      if (index >= length) return length;
      if (!isDigit(index)) return index;
      while (isDigit(index)) index += 1;
    }
    return null;
  };

  /**
   * Reads one value, or opens a container. Returns the offset of a fault, or
   * null; a container that opens leaves its entry on the stack to be read by
   * the loop.
   */
  const readValue = (): number | null => {
    if (index >= length) return length;
    const char = source[index];
    if (char === '{') {
      index += 1;
      stack.push({ closer: '}', awaiting: 'key-or-close' });
      return null;
    }
    if (char === '[') {
      index += 1;
      stack.push({ closer: ']', awaiting: 'value-or-close' });
      return null;
    }
    if (char === '"') return readString();
    if (char === '-' || isDigit(index)) return readNumber();
    for (const keyword of ['true', 'false', 'null']) {
      if (char === keyword[0]) {
        // Gecko's convention: the whole keyword or an error at its start.
        if (!source.startsWith(keyword, index)) return index;
        index += keyword.length;
        return null;
      }
    }
    return index;
  };

  /** After a value is complete: the container it was in now wants a comma or its close. */
  const valueDone = (): void => {
    const top = stack.at(-1);
    if (top) top.awaiting = 'comma-or-close';
  };

  skipSpace();
  const first = readValue();
  if (first !== null) return first;

  while (stack.length > 0) {
    skipSpace();
    const top = stack.at(-1);
    if (top === undefined) break;
    if (index >= length) return length;
    const char = source[index];

    switch (top.awaiting) {
      case 'value-or-close':
      case 'key-or-close':
      case 'comma-or-close':
        if (char === top.closer) {
          index += 1;
          stack.pop();
          valueDone();
          continue;
        }
        if (top.awaiting === 'comma-or-close') {
          if (char !== ',') return index;
          index += 1;
          top.awaiting = top.closer === '}' ? 'key' : 'value';
          continue;
        }
        if (top.awaiting === 'key-or-close') {
          if (char !== '"') return index;
          const fault = readString();
          if (fault !== null) return fault;
          top.awaiting = 'colon';
          continue;
        }
        break;
      case 'key': {
        if (char !== '"') return index;
        const fault = readString();
        if (fault !== null) return fault;
        top.awaiting = 'colon';
        continue;
      }
      case 'colon':
        if (char !== ':') return index;
        index += 1;
        top.awaiting = 'value';
        continue;
      case 'value':
        break;
    }

    // 'value' and 'value-or-close' that is not a close: read the value.
    const depth = stack.length;
    const fault = readValue();
    if (fault !== null) return fault;
    // A scalar completes at once; a container that opened completes when it
    // closes, in the loop above.
    if (stack.length === depth) valueDone();
  }

  skipSpace();
  return index < length ? index : null;
}
