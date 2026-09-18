#!/usr/bin/env node
/**
 * Reads this tool's own YAML output with a THIRD implementation and commits
 * the answers.
 *
 * The writing row of docs/conversion-matrix.md has rested on js-yaml since
 * round two - one independent reader, which is one more than the zero it had
 * before, and still one. PyYAML settled two disagreements after that (the `\n`
 * block scalar in round two, the empty-document rule in round three) but it was
 * settled BY HAND: a sentence in a comment, with nothing in the suite that
 * would notice if the answer changed.
 *
 * So the same corpus the js-yaml check uses is written out by this tool, read
 * by CPython's PyYAML, and the verdict committed. Three implementations with
 * three ancestries: `yaml` (ours), js-yaml (a port of PyYAML), and PyYAML
 * itself.
 *
 * WHY A FIXTURE AND NOT A TEST THAT RUNS PYTHON. The suite runs on any machine
 * with Node and nothing else; a test that shells out to CPython would be a test
 * that is skipped on the machines that do not have it, which is the same as not
 * having it. The committed answers are a diff in review instead.
 *
 * WHAT THE FIXTURE IS TIED TO. Each entry carries the exact YAML this tool
 * produced. The test asserts that the writer still produces those bytes before
 * it believes the verdict beside them - so a changed writer shows up as a
 * failure telling you to regenerate, rather than as a stale verdict about
 * output nobody has read.
 *
 * Regenerate with:
 *
 *     node scripts/generate-yaml-writer-oracle.mjs > src/tools/structured-data/spec/yaml-writer-pyyaml.json && pnpm format
 *
 * Needs Python 3 with PyYAML installed; nothing at test time does.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite';

const ROOT = new URL('..', import.meta.url);

/* ========================================================================== *
 * This tool's writer, loaded the way the app loads it
 * ========================================================================== */

/*
 * Vite's SSR loader rather than a build step: `convert.ts` is TypeScript with
 * `@/` aliases, and the alternative is a second copy of the module graph that
 * could drift from the one the app ships. `configFile: false` keeps the app's
 * plugins (React, the router, the CSP hash) out of a load that needs none of
 * them.
 */
const server = await createServer({
  configFile: false,
  resolve: { alias: { '@': fileURLToPath(new URL('src', ROOT)) } },
  server: { middlewareMode: true },
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
});

const { parseSource, serialise } = await server.ssrLoadModule(
  '/src/tools/structured-data/convert.ts',
);

/* ========================================================================== *
 * The corpus: the suite's own documents, not values invented here
 * ========================================================================== */

const suite = JSON.parse(
  await readFile(new URL('src/tools/structured-data/spec/yaml-test-suite.json', ROOT), 'utf8'),
);

/*
 * Every case this tool can READ, which is the only corpus for which there is a
 * value to write. Deliberately including the ones js-yaml refuses: which
 * implementations agree about them is the question, so filtering them out
 * before asking is the one thing this file must not do.
 */
const corpus = [];
for (const entry of suite.cases) {
  if (entry.error) continue;
  if (entry.documents === null || entry.documents === undefined) continue;

  const value = entry.documents.length === 1 ? entry.documents[0] : entry.documents;
  const parsed = parseSource(entry.yaml, 'yaml', ',');
  if (!parsed.ok) continue;

  const written = serialise(parsed.value, 'yaml', { indent: 2, delimiter: ',' });
  if (!written.ok) continue;

  corpus.push({ id: entry.id, label: entry.label, value: parsed.value, yaml: written.value });
  void value;
}

await server.close();

if (corpus.length < 250) {
  throw new Error(`only ${String(corpus.length)} documents to write; expected the suite's corpus`);
}

/* ========================================================================== *
 * CPython, reading it
 * ========================================================================== */

/*
 * THE COMPARISON HAPPENS IN PYTHON, NOT AFTER A json.dumps.
 *
 * `json.dumps` coerces a non-string dict key to a string, which would hide the
 * single most interesting failure a YAML writer can have: an unquoted key that
 * the reader resolves to a boolean or an integer. `True` and `"True"` are two
 * different keys and `json.dumps` prints both as `"true"`. So the value goes IN
 * as JSON, and the equality is decided against the loaded Python object with
 * types compared explicitly.
 */
const PYTHON = `
import json, sys, yaml

def equal(loaded, expected):
    if expected is None:
        return loaded is None
    if isinstance(expected, bool):
        return isinstance(loaded, bool) and loaded == expected
    if isinstance(expected, (int, float)):
        if isinstance(loaded, bool) or not isinstance(loaded, (int, float)):
            return False
        return loaded == expected
    if isinstance(expected, str):
        return isinstance(loaded, str) and loaded == expected
    if isinstance(expected, list):
        return (
            isinstance(loaded, list)
            and len(loaded) == len(expected)
            and all(equal(a, b) for a, b in zip(loaded, expected))
        )
    if isinstance(expected, dict):
        if not isinstance(loaded, dict) or len(loaded) != len(expected):
            return False
        for key, value in expected.items():
            # A key that is not a str is a key this tool did not write: a
            # missing pair of quotes turns "true" into True, and True is not a
            # key any JSON value can hold.
            if key not in loaded or not isinstance(key, str):
                return False
            if not equal(loaded[key], value):
                return False
        return True
    return False

def describe(value):
    if isinstance(value, dict):
        return {("!%s!%r" % (type(k).__name__, k)) if not isinstance(k, str) else k: describe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [describe(v) for v in value]
    if isinstance(value, (str, bool, int, float)) or value is None:
        return value
    return "!%s!%r" % (type(value).__name__, value)

out = []
for item in json.load(sys.stdin):
    try:
        loaded = yaml.safe_load(item["yaml"])
    except Exception as error:
        out.append({"id": item["id"], "read": "refused", "detail": type(error).__name__, "agrees": False})
        continue
    out.append({
        "id": item["id"],
        "agrees": equal(loaded, item["value"]),
        **({} if equal(loaded, item["value"]) else {"read": describe(loaded)}),
    })

json.dump({"library": "PyYAML", "version": yaml.__version__, "python": sys.version.split()[0], "results": out}, sys.stdout, default=str)
`;

function askPython(items) {
  return JSON.parse(
    execFileSync('py', ['-3', '-c', PYTHON], {
      input: JSON.stringify(items),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

const python = askPython(corpus.map(({ id, value, yaml }) => ({ id, value, yaml })));

/* ========================================================================== *
 * The negative control, which runs before anything is written
 * ========================================================================== */

/*
 * 280 documents agreeing on the first run is the shape of a check that is not
 * running. This one asks PyYAML about output that is deliberately wrong - the
 * quotes taken off a string that spells a number - and refuses to write a
 * fixture unless PyYAML says no.
 */
const control = askPython([
  {
    id: 'control-quoted',
    value: { version: '1.10', id: '0123' },
    yaml: 'version: "1.10"\nid: "0123"\n',
  },
  {
    id: 'control-unquoted',
    value: { version: '1.10', id: '0123' },
    yaml: 'version: 1.10\nid: 0123\n',
  },
  { id: 'control-unquoted-key', value: { true: 1 }, yaml: 'true: 1\n' },
]);

const controlBy = Object.fromEntries(control.results.map((entry) => [entry.id, entry]));
if (controlBy['control-quoted'].agrees !== true) {
  throw new Error('the control says PyYAML cannot read correct output');
}
if (controlBy['control-unquoted'].agrees !== false) {
  throw new Error('the control says PyYAML cannot tell an unquoted number from a string');
}
if (controlBy['control-unquoted-key'].agrees !== false) {
  throw new Error('the control says PyYAML cannot tell a boolean key from a string key');
}

/* ========================================================================== */

const verdicts = Object.fromEntries(python.results.map((entry) => [entry.id, entry]));

const fixture = {
  generator: 'this tool’s YAML writer, read by CPython PyYAML',
  reader: `PyYAML ${python.version} on CPython ${python.python}`,
  corpus: `yaml-test-suite ${suite.generator.replace('yaml-test-suite ', '')}`,
  counts: {
    total: corpus.length,
    agreed: python.results.filter((entry) => entry.agrees).length,
    disagreed: python.results.filter((entry) => !entry.agrees).map((entry) => entry.id),
  },
  cases: corpus.map((entry) => ({
    id: entry.id,
    label: entry.label,
    value: entry.value,
    yaml: entry.yaml,
    pyyaml: verdicts[entry.id],
  })),
};

process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
