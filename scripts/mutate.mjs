#!/usr/bin/env node
/**
 * MUTATION TESTING OVER THE CONVERSION CODE. Dev-only; nothing ships with it
 * and nothing in the six gates runs it.
 *
 * One small, syntactically valid change to a source file at a time, with the
 * tests that claim to cover it run against each. A change nothing notices is a
 * claim nothing is holding. Round four asked this question of a deterministic
 * SAMPLE and wrote "the survivors it has not reached" down as a category; this
 * script exists so that the category can be emptied rather than described, and
 * so the next person can re-run the sweep instead of re-inventing it.
 *
 *     node scripts/mutate.mjs                     # every target
 *     node scripts/mutate.mjs src/tools/diff/compute.ts
 *     node scripts/mutate.mjs --report            # read an existing run
 *
 * Results land in `.mutation/` (git-ignored), one JSON line per mutant, and a
 * run resumes from where it stopped.
 *
 * READING THE SURVIVORS IS THE WORK. About half of them are EQUIVALENT - a
 * change that cannot alter behaviour, like flipping one arm of a `||` whose
 * first arm has already decided the answer. The output is a list to read, not a
 * score to report.
 */
import { execSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STORE = join(ROOT, '.mutation');

/**
 * Each file, with the tests that claim to cover it.
 *
 * The suite is named per target rather than "run everything": a full run is
 * forty times the cost and answers a question nobody asked. What it must not
 * be is narrower than the tests that actually reach the file - a mutant killed
 * only by a test this list leaves out is a mutant recorded as a survivor.
 */
const TARGETS = {
  'src/tools/structured-data/convert.ts': ['src/tools/structured-data'],
  'src/tools/structured-data/csv.ts': ['src/tools/structured-data'],
  'src/tools/structured-data/jsonc.ts': ['src/tools/structured-data'],
  'src/tools/structured-data/report.ts': ['src/tools/structured-data'],
  'src/tools/diff/compute.ts': ['src/tools/diff', 'src/features/toolrunner/DiffView.test.tsx'],
};

/**
 * The operators, applied to source TEXT rather than to an AST.
 *
 * A token-level rewrite is crude, and that is the point: it produces exactly
 * the changes a compiler accepts and a reviewer does not notice, which is the
 * population worth asking about. Comments, string literals and any line
 * holding a regular expression are left alone - a mutant inside a message
 * changes only the message, and a mutant inside a character class produces a
 * hundred survivors that mean nothing.
 */
const RULES = [
  { find: /(?<![<>=!])<=(?!=)/g, to: '<', kind: 'boundary' },
  { find: /(?<![<>=!])>=(?!=)/g, to: '>', kind: 'boundary' },
  { find: /(?<![<>=!])<(?![<=])/g, to: '<=', kind: 'boundary' },
  { find: /(?<![<>=!])>(?![>=])/g, to: '>=', kind: 'boundary' },
  { find: /===/g, to: '!==', kind: 'equality' },
  { find: /!==/g, to: '===', kind: 'equality' },
  { find: /&&/g, to: '||', kind: 'logic' },
  { find: /\|\|(?!=)/g, to: '&&', kind: 'logic' },
  { find: /(?<![+\-*/%=])\+(?![+=])/g, to: '-', kind: 'arithmetic' },
  { find: /(?<![+\-*/%=<>])-(?![-=>])/g, to: '+', kind: 'arithmetic' },
  { find: /(?<![*/])\*(?![*/=])/g, to: '/', kind: 'arithmetic' },
  { find: /(?<![\w.])0(?![\w.])/g, to: '1', kind: 'constant' },
  { find: /(?<![\w.])1(?![\w.])/g, to: '0', kind: 'constant' },
  { find: /(?<![\w.])2(?![\w.])/g, to: '3', kind: 'constant' },
  { find: /(?<![\w.])true(?![\w])/g, to: 'false', kind: 'boolean' },
  { find: /(?<![\w.])false(?![\w])/g, to: 'true', kind: 'boolean' },
];

/** Character ranges that are a comment or a string literal, and so inert. */
function inertRanges(source) {
  const ranges = [];
  let at = 0;
  let mode = null;
  let start = 0;
  let quote = '';

  while (at < source.length) {
    const two = source.slice(at, at + 2);
    if (mode === null) {
      if (two === '//' || two === '/*') {
        mode = two === '//' ? 'line' : 'block';
        start = at;
        at += 2;
      } else if (source[at] === '"' || source[at] === "'" || source[at] === '`') {
        mode = 'string';
        quote = source[at];
        start = at;
        at += 1;
      } else at += 1;
      continue;
    }

    if (mode === 'line') {
      if (source[at] === '\n') {
        ranges.push([start, at]);
        mode = null;
      }
      at += 1;
    } else if (mode === 'block') {
      if (two === '*/') {
        ranges.push([start, at + 2]);
        mode = null;
        at += 2;
      } else at += 1;
    } else if (source[at] === '\\') {
      at += 2;
    } else {
      if (source[at] === quote) {
        ranges.push([start, at + 1]);
        mode = null;
      }
      at += 1;
    }
  }

  if (mode !== null) ranges.push([start, source.length]);
  return ranges;
}

function mutantsFor(path, source) {
  const inert = inertRanges(source);
  const isInert = (index) => inert.some(([from, to]) => index >= from && index < to);
  const lineStart = (index) => source.lastIndexOf('\n', index) + 1;
  const lineEnd = (index) => {
    const at = source.indexOf('\n', index);
    return at === -1 ? source.length : at;
  };

  const out = [];
  for (const rule of RULES) {
    for (const match of source.matchAll(rule.find)) {
      const index = match.index;
      if (isInert(index)) continue;
      const line = source.slice(lineStart(index), lineEnd(index));
      if (/\/[^/*\s].*\//.test(line)) continue;
      out.push({
        path,
        index,
        length: match[0].length,
        from: match[0],
        to: rule.to,
        kind: rule.kind,
        line: source.slice(0, index).split('\n').length,
        context: line.trim().slice(0, 100),
      });
    }
  }

  return out.sort((a, b) => a.index - b.index || (a.to < b.to ? -1 : 1));
}

/**
 * Runs a suite, and says which of three things happened.
 *
 * THE TIMEOUT IS NOT A CONVENIENCE. Turning `index += 1` into `index -= 1`
 * inside a scanner is an infinite loop, and vitest cannot interrupt a blocked
 * worker thread - a sweep will sit on one until somebody notices. A run that
 * does not finish is a kill, and it is recorded as its own outcome so that
 * `killed` does not quietly absorb it.
 */
function runSuite(files) {
  try {
    execSync(`pnpm exec vitest run ${files.join(' ')} --reporter=dot`, {
      cwd: ROOT,
      stdio: 'ignore',
      timeout: 120_000,
    });
    return 'survived';
  } catch (error) {
    return error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT' ? 'timeout' : 'killed';
  }
}

function report() {
  for (const path of Object.keys(TARGETS)) {
    const file = join(STORE, `${path.replaceAll('/', '_')}.jsonl`);
    if (!existsSync(file)) continue;
    const rows = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
    const survivors = rows.filter((row) => row.outcome === 'survived');
    console.log(
      `\n${path}: ${String(rows.length)} run, ${String(survivors.length)} survived, ${String(
        rows.filter((row) => row.outcome === 'timeout').length,
      )} timed out`,
    );
    for (const row of survivors) {
      console.log(`  :${String(row.line).padStart(5)}  ${row.from} -> ${row.to}   ${row.context}`);
    }
  }
}

/* ========================================================================== */

const args = process.argv.slice(2);
if (args.includes('--report')) {
  report();
  process.exit(0);
}

mkdirSync(STORE, { recursive: true });

const chosen = args.length > 0 ? args : Object.keys(TARGETS);
for (const path of chosen) {
  const suites = TARGETS[path];
  if (suites === undefined) throw new Error(`no suite listed for ${path}`);

  /*
   * THE BASELINE RUNS BEFORE THE ORIGINAL IS CAPTURED, and both halves of that
   * sentence were learned the hard way. An invocation that cannot run the
   * suite at all reports every mutant as killed and looks like a perfect
   * score. A tree still holding somebody else's mutant gets that mutant
   * captured as the original and baked into every result after it.
   */
  if (runSuite(suites) !== 'survived') {
    console.error(`${path}: the suite does not pass unmutated; refusing to run`);
    process.exitCode = 1;
    break;
  }

  const original = readFileSync(join(ROOT, path), 'utf8');
  const backup = join(STORE, `${path.replaceAll('/', '_')}.orig`);
  copyFileSync(join(ROOT, path), backup);

  const mutants = mutantsFor(path, original);
  const results = join(STORE, `${path.replaceAll('/', '_')}.jsonl`);
  const done = existsSync(results)
    ? readFileSync(results, 'utf8')
        .split('\n')
        .filter((line) => line !== '').length
    : 0;

  console.log(`${path}: ${String(mutants.length)} mutants, resuming at ${String(done)}`);

  try {
    for (let at = done; at < mutants.length; at += 1) {
      const mutant = mutants[at];
      writeFileSync(
        join(ROOT, path),
        original.slice(0, mutant.index) + mutant.to + original.slice(mutant.index + mutant.length),
        'utf8',
      );

      const outcome = runSuite(suites);
      appendFileSync(results, `${JSON.stringify({ ...mutant, outcome })}\n`, 'utf8');

      if (outcome !== 'killed') {
        console.log(
          `  ${outcome.toUpperCase()} :${String(mutant.line)}  ${mutant.from} -> ${mutant.to}   ${mutant.context}`,
        );
      }
    }
  } finally {
    writeFileSync(join(ROOT, path), original, 'utf8');
  }

  // And again at the end: an invocation that broke halfway through would leave
  // the second half of the run looking perfect.
  if (runSuite(suites) !== 'survived') {
    console.error(`${path}: the suite does not pass after restoring; results are suspect`);
    process.exitCode = 1;
  }
}

report();
