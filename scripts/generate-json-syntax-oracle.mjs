#!/usr/bin/env node
/**
 * Where three engines say a JSON document stops being JSON, committed.
 *
 * WHY. The structured-data tool took a syntax error's position from the
 * engine's own message, with two regular expressions. Measured in round
 * sixteen, over this file's sweep: Gecko's message carries a line and column
 * every time, V8's for some shapes of fault and not others, and
 * JavaScriptCore's never - so on the tool page a Safari user was never told
 * where their JSON was wrong, and a Chrome user was told for a trailing comma
 * in an object and not in an array. The test that should have caught it
 * passed because the one document it used happened to produce V8's other
 * message format.
 *
 * So the position is now found by `locateJsonSyntaxError`, which reads the
 * document against RFC 8259's grammar and does not read any engine's
 * sentence. This file is what it is held to: the offsets Gecko and V8 give,
 * which are two parsers with no ancestry in common with each other or with
 * ours, for every document in a sweep no hand-written list would match.
 *
 * THE SWEEP. A handful of valid seed documents - every kind of value, every
 * escape, every number shape, all four whitespace characters, nesting - and at
 * every position of each, on a FIXED stride so the fixture is the same for
 * everybody: the character deleted, replaced by each of a fixed alphabet of
 * JSON's own syntax, and the same alphabet inserted. Whatever V8's JSON.parse
 * refuses is a case.
 *
 * VERIFIED BEFORE IT IS WRITTEN, as CONTRIBUTING asks of a generator that
 * converts before it compares: every case must be refused by all three
 * engines, and Gecko must give a position for every one. Where Gecko and V8
 * both give one they agree, with ONE class of exception, found by the first
 * run of this script and now checked rather than tolerated: a misspelled
 * keyword. `tru0` is at the `t` for Gecko - the token that is wrong - and at
 * the `0` for V8 - the first character that does not continue it. Both are
 * defensible; this repository takes Gecko's (see `locateJsonSyntaxError`),
 * and any disagreement that is not a keyword, or that puts V8 outside the
 * keyword Gecko points at, stops the script rather than being written down.
 *
 *     node scripts/generate-json-syntax-oracle.mjs && pnpm exec prettier --write src/lib/spec/json-syntax-oracle.json
 *
 * Needs Firefox, Chromium and WebKit; nothing at test time does.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import { chromium, firefox, webkit } from 'playwright';

const OUT = new URL('../src/lib/spec/json-syntax-oracle.json', import.meta.url);

const SEEDS = [
  '{"name": "patchbay", "tags": ["a", "b"], "count": 3, "ok": true, "none": null}',
  '[\n\t-0.5e+10,\r\n\t{"k": "\\u00e9\\n\\"\\\\/"},\n\t[], {}, false\n]',
  '{"a": {"b": [1, 2.25, -3E-2, 0]}, "c": ""}',
  ' "just a string with a \\t tab" ',
  '[{"x": 1}, {"y": [true, null, "z"]}]',
];

const ALPHABET = [
  '{',
  '}',
  '[',
  ']',
  ',',
  ':',
  '"',
  '\\',
  '0',
  '1',
  '-',
  '.',
  'e',
  't',
  'n',
  ' ',
  '\n',
  'x',
];

/** Every Nth position of each seed, and every mutation there. */
const STRIDE = 3;

function* mutations() {
  for (const seed of SEEDS) {
    for (let at = 0; at <= seed.length; at += STRIDE) {
      if (at < seed.length) yield seed.slice(0, at) + seed.slice(at + 1);
      for (const character of ALPHABET) {
        if (at < seed.length) yield seed.slice(0, at) + character + seed.slice(at + 1);
        yield seed.slice(0, at) + character + seed.slice(at);
      }
    }
  }
}

const refusedByV8 = (text) => {
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
};

const sources = [...new Set(mutations())].filter(refusedByV8);

/** A line and column counted the way Gecko and V8 both count them: from 1, in UTF-16 units. */
function offsetOf(source, line, column) {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = source.indexOf('\n', offset);
    if (next === -1) return null;
    offset = next + 1;
  }
  return offset + column - 1;
}

function positionIn(source, message) {
  const lineColumn = /line (\d+) column (\d+)/i.exec(message);
  if (lineColumn) return offsetOf(source, Number(lineColumn[1]), Number(lineColumn[2]));
  const offset = /position (\d+)/i.exec(message);
  return offset ? Number(offset[1]) : null;
}

const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><title>json</title>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const origin = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;

const answers = {};
const versions = {};
for (const [name, engine] of [
  ['firefox', firefox],
  ['chromium', chromium],
  ['webkit', webkit],
]) {
  const browser = await engine.launch();
  versions[name] = browser.version();
  const page = await browser.newPage();
  await page.goto(origin);
  answers[name] = await page.evaluate(
    (texts) =>
      texts.map((text) => {
        try {
          JSON.parse(text);
          return { refused: false, message: '' };
        } catch (error) {
          return { refused: true, message: String(error instanceof Error ? error.message : error) };
        }
      }),
    sources,
  );
  await browser.close();
}
server.close();

const cases = [];
let bothGave = 0;
let keywordDisagreements = 0;
for (const [index, source] of sources.entries()) {
  const gecko = answers.firefox[index];
  const v8 = answers.chromium[index];
  const jsc = answers.webkit[index];
  if (!gecko.refused || !v8.refused || !jsc.refused) {
    throw new Error(
      `the engines disagree on whether ${JSON.stringify(source)} is JSON; refusing to write`,
    );
  }
  const firefoxOffset = positionIn(source, gecko.message);
  const chromiumOffset = positionIn(source, v8.message);
  if (firefoxOffset === null) {
    throw new Error(`Gecko gave no position for ${JSON.stringify(source)}: ${gecko.message}`);
  }
  if (chromiumOffset !== null) {
    bothGave += 1;
    if (chromiumOffset !== firefoxOffset) {
      const keyword = /unexpected keyword/.test(gecko.message);
      const inside = chromiumOffset > firefoxOffset && chromiumOffset <= firefoxOffset + 4;
      if (!keyword || !inside) {
        throw new Error(
          `Gecko says ${String(firefoxOffset)} and V8 ${String(chromiumOffset)} for ${JSON.stringify(source)}, and it is not a misspelled keyword; refusing to write`,
        );
      }
      keywordDisagreements += 1;
    }
  }
  cases.push([source, firefoxOffset, chromiumOffset, positionIn(source, jsc.message) !== null]);
}

const summary = {
  cases: cases.length,
  firefoxGavePosition: cases.length,
  chromiumGavePosition: bothGave,
  webkitGavePosition: cases.filter((entry) => entry[3]).length,
  geckoAndV8DisagreeOnAKeyword: keywordDisagreements,
};

await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(
  OUT,
  `${JSON.stringify(
    {
      '$schema-note':
        'GENERATED by scripts/generate-json-syntax-oracle.mjs - do not edit by hand. Every single-character deletion, substitution and insertion, on a fixed stride, of five valid seed documents that JSON.parse refuses. Each case is [source, the UTF-16 offset of the fault as Gecko reports it, the offset V8 reports or null where its message has none, whether JavaScriptCore reported one at all]. Gecko and V8 agree wherever both report, except on a misspelled keyword, where Gecko points at the keyword and V8 inside it - checked by the generator.',
      engines: versions,
      seeds: SEEDS,
      alphabet: ALPHABET,
      stride: STRIDE,
      summary,
      cases,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify(summary));
