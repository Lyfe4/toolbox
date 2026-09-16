#!/usr/bin/env node
/**
 * THE JSONC ORACLE.
 *
 * `structured-data` reads JSON with comments and trailing commas, which is what
 * `tsconfig.json`, VS Code settings and most JSON an LLM writes actually are.
 * The stripper that makes that possible - `stripJsonc` - is forty lines of
 * character scanning, and forty lines of character scanning tested against
 * expected values somebody wrote by reading them is a test that the file agrees
 * with the module beside it.
 *
 * So it is held to `jsonc-parser`, which is the parser Visual Studio Code uses
 * for its own settings files and the closest thing JSONC has to a reference
 * implementation. Its answers are written into `spec/jsonc.json` and committed,
 * so the suite needs no dependency at test time and a change to either side is
 * a diff in review - the same bargain the CSV, YAML and git oracles strike.
 *
 * WHAT IT COMPARES IS THE VALUE, not the stripped text. The two implementations
 * blank different things - jsonc-parser removes comments and lets its own
 * parser tolerate the trailing comma, this one blanks both - so comparing the
 * intermediate strings would compare two implementation details. What has to
 * agree is the DOCUMENT: what does this text mean.
 *
 *   node scripts/generate-jsonc-oracle.mjs
 *
 * Writes src/tools/structured-data/spec/jsonc.json.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import { format } from 'prettier';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'tools', 'structured-data', 'spec', 'jsonc.json');

/**
 * The corpus.
 *
 * Every entry is a document somebody could plausibly paste, plus the awkward
 * cases that decide whether a stripper is string-aware: a `//` inside a string,
 * a `/*` inside a string, an escaped quote before one, a comment marker inside
 * a comment, and a trailing comma with a comment between it and the bracket.
 */
const CASES = [
  ['plain json', '{"a": 1}'],
  ['line comment before a key', '{\n  // a comment\n  "a": 1\n}'],
  ['line comment after a value', '{\n  "a": 1 // trailing\n}'],
  ['block comment', '{\n  /* a comment */\n  "a": 1\n}'],
  ['block comment across lines', '{\n  /* one\n     two */\n  "a": 1\n}'],
  ['trailing comma in an object', '{"a": 1,}'],
  ['trailing comma in an array', '[1, 2, 3,]'],
  ['trailing comma with a comment between', '[1, 2, /* end */ ]'],
  ['trailing comma and a line comment', '{\n  "a": 1,\n  // done\n}'],
  ['nested trailing commas', '{"a": [1,], "b": {"c": 2,},}'],
  ['a slash-slash inside a string', '{"url": "https://example.com/a"}'],
  ['a slash-star inside a string', '{"glob": "/*.ts"}'],
  ['a star-slash inside a string', '{"glob": "a*/b"}'],
  ['an escaped quote before a comment marker', '{"a": "he said \\"//\\"", "b": 1}'],
  ['an escaped backslash then a quote', '{"a": "ends with a backslash \\\\", "b": 2}'],
  ['a comment marker inside a block comment', '{\n  /* // not a line comment */\n  "a": 1\n}'],
  ['a comma inside a string before a brace', '{"a": "x,", "b": 2}'],
  [
    'a tsconfig-shaped document',
    '{\n  // See https://aka.ms/tsconfig\n  "compilerOptions": {\n    "target": "ES2022", // modern\n    "strict": true,\n  },\n  "include": ["src"],\n}',
  ],
  ['an array of objects with comments', '[\n  // first\n  {"a": 1},\n  // second\n  {"b": 2},\n]'],
  ['comments only around a scalar', '/* lead */ 42 // tail'],
  ['a string that is only a comment marker', '"//"'],
  ['an empty object with a comment', '{\n  // nothing here\n}'],
  ['an empty array with a comment', '[\n  // nothing here\n]'],
  ['unicode escapes beside a comment', '{"a": "\\u00e9", // accent\n "b": 1}'],
  ['a document with CRLF line endings', '{\r\n  // a comment\r\n  "a": 1\r\n}'],
];

const cases = CASES.map(([name, text]) => {
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  return {
    name,
    text,
    // `undefined` is not JSON, so a document jsonc-parser cannot read is
    // recorded as a refusal rather than as a missing field.
    ok: errors.length === 0,
    value: errors.length === 0 ? (value ?? null) : null,
    errors: errors.map((error) => printParseErrorCode(error.error)),
  };
});

// The installed version, read from the package rather than written here, so
// the fixture says what actually produced it.
const version = JSON.parse(
  readFileSync(join(here, '..', 'node_modules', 'jsonc-parser', 'package.json'), 'utf8'),
).version;

const payload = {
  generator: `jsonc-parser ${version}`,
  counts: { total: cases.length, readable: cases.filter((entry) => entry.ok).length },
  cases,
};

/*
 * THROUGH PRETTIER, NOT STRAIGHT OUT OF `JSON.stringify`.
 *
 * `format:check` is one of the six gates and it covers `.json`, and Prettier
 * collapses a short array onto one line where `JSON.stringify(x, null, 2)`
 * spreads it. A fixture written the second way is a fixture that fails the
 * gate the moment it is regenerated - so the generator produces exactly what
 * the repository's own formatter would, and "regenerating reproduces it byte
 * for byte from a clean checkout" stays a claim anybody can check with a diff.
 */
const text = await format(JSON.stringify(payload, null, 2), { parser: 'json' });

writeFileSync(out, text, { encoding: 'utf8' });

// The digest is over the bytes written, so a regeneration that produces the
// same corpus produces the same file - which is what makes "reproduces byte for
// byte from a clean checkout" a claim anybody can check.
process.stdout.write(
  `${out}\n${cases.length} cases, sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}\n`,
);
