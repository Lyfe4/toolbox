import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * WHAT THE DOCUMENTS NAME EXISTS, AND WHAT THEY COUNT IS THE COUNT.
 *
 * `docLinks.test.ts` beside this one holds the links. This holds the rest of
 * what a sentence can get wrong mechanically, because the documentation audit
 * of round seventeen found that documents in this repository had described
 * behaviour that did not exist at least seven times before it, and every
 * round that corrected them left more to find. A one-off audit decays; a
 * check in the gates does not.
 *
 * Four rules, each for a kind of false sentence that has actually shipped:
 *
 * 1. **A name in a document is a name in the code.** A backticked file must
 *    exist, and a backticked identifier must appear in code with the comments
 *    taken out - so a comment cannot vouch for a function that is gone. The
 *    removed `reportProgress`, the `checkInspectorState` a harness comment
 *    pointed at for months and never existed, a renamed port: each is a name
 *    that stopped resolving, and a reader cannot tell from the sentence.
 * 2. **A harness section named anywhere is a harness section.** `check…`
 *    names are the one vocabulary docs, comments and briefs share, and they
 *    are renamed.
 * 3. **A count of something the code can count is counted.** "The one inline
 *    script" was wrong in three files at once; there were two. Each entry in
 *    `COUNTS` is a phrase pattern and the thing it counts, applied to every
 *    document AND every source file, and each must still match somewhere - a
 *    pattern that matches nothing is a check that has silently retired.
 * 4. **The test count is not written by hand.** It was wrong at least three
 *    times, twice within one round. `pnpm test` prints it.
 *
 * WHAT THIS CANNOT DO, which is most of it: it cannot tell whether a sentence
 * about behaviour is true. It can only make sure the things the sentence
 * names still exist, and that the numbers it can count are counted. Behaviour
 * is the tests' job; where a document makes a claim no test holds and none
 * can, the convention is an `<!-- unverified: why -->` comment beside it, so
 * the claim does not look identical to a checked one - and where a test does
 * hold it, `<!-- asserted: <file> › <title> -->`, which this file resolves.
 * See CONTRIBUTING.md, "Claims in documents".
 *
 * WHY `vite/`: the same reason as `docLinks.test.ts` - it reads the
 * filesystem, and the browser project has no Node types on purpose.
 */

const ROOT = process.cwd();

/* ========================================================================== *
 * The corpus
 * ========================================================================== */

/**
 * DATED DOCUMENTS: a record of what was true on a date, by their own header.
 * They name things that were removed on purpose - that is what a record of a
 * removal is - so rule 1's identifier half and the counts do not apply. Their
 * links and file names still must resolve: a record that points at nothing is
 * not a record.
 */
const DATED: Readonly<Record<string, string>> = {
  'docs/test-findings.md':
    'a per-round log; each round is headed by its date and commit, and earlier rounds are never rewritten',
  'docs/video-convert-feasibility.md':
    'a snapshot of a decision, by its own header - "left as the snapshot it was"',
};

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  '.netlify',
  '.tanstack',
  'coverage',
  '.mutation',
  'evidence',
]);

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.json',
  '.toml',
  '.yml',
  '.yaml',
  '.py',
]);

/** Files without an extension that are configuration, and so code. */
const TEXT_NAMES = new Set(['_headers', '_redirects']);

/** Generated or vendored: not prose anybody wrote, and not code anybody reads. */
const NOT_OURS = new Set(['pnpm-lock.yaml', 'src/routeTree.gen.ts']);

/**
 * Every file in the repository, whatever its type: what a document may name.
 * The skipped directories are what .gitignore keeps out of a clone, so this
 * list is the same on a machine that has built and on CI, which has not.
 */
function everyFile(): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      // `.claude/` is per machine except its skills - the same line .gitignore draws.
      if (relative === '.claude' && entry.name !== 'skills') continue;
      if (entry.isDirectory()) walk(resolve(directory, entry.name), path);
      else found.push(path);
    }
  };
  walk(ROOT, '');
  return found.sort();
}

const EVERY_FILE = everyFile();
const EVERY_FILE_SET = new Set(EVERY_FILE);
/** The text among them that somebody wrote: what this file reads for claims. */
const FILES = EVERY_FILE.filter(
  (path) =>
    (TEXT_EXTENSIONS.has(extname(path)) || TEXT_NAMES.has(basename(path))) && !NOT_OURS.has(path),
);
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');
const TEXT = new Map(FILES.map((path) => [path, read(path)]));
const textOf = (path: string): string => TEXT.get(path) ?? '';

const DOCUMENTS = FILES.filter((path) => path.endsWith('.md'));
const CURRENT_DOCUMENTS = DOCUMENTS.filter((path) => !(path in DATED));
const CODE = FILES.filter((path) => !path.endsWith('.md'));

/* ========================================================================== *
 * Reading prose out of documents and code
 * ========================================================================== */

/** A Markdown document with its fenced blocks removed: a fence is an example, not a claim. */
export function proseOf(markdown: string): string {
  return markdown.replace(/^ *(```|~~~)[\s\S]*?^ *\1/gm, '');
}

/** Every inline code span in a document's prose. */
export function codeSpans(markdown: string): readonly string[] {
  return [...proseOf(markdown).matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].map((match) => match[1] ?? '');
}

/**
 * Code with its comments removed, so a name that survives only in a comment
 * does not count as existing.
 *
 * A regex, not a parser, and imperfect in the SAFE direction: a `//` inside a
 * string that is not a URL loses the rest of that line, which can only make a
 * name look missing - a loud failure, never a quiet pass.
 */
export function withoutComments(source: string, path: string): string {
  if (
    path.endsWith('.py') ||
    path.endsWith('.toml') ||
    path.endsWith('.yml') ||
    TEXT_NAMES.has(basename(path))
  ) {
    return source.replace(/(^|\s)#[^\n]*/g, '$1');
  }
  if (path.endsWith('.html')) return source.replace(/<!--[\s\S]*?-->/g, '');
  if (path.endsWith('.json')) return source;
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<![:'"`\\/])\/\/[^\n]*/g, '');
}

/** The comments of a source file, joined: the prose half of code. */
export function commentsOf(source: string, path: string): string {
  if (!/\.(tsx?|m?js|cjs|css)$/.test(path)) return '';
  const blocks = [...source.matchAll(/\/\*[\s\S]*?\*\/|(?<![:'"`\\/])\/\/[^\n]*/g)];
  return blocks.map((match) => match[0]).join('\n');
}

/** Every identifier-shaped token in a piece of code. */
function tokensOf(code: string): Set<string> {
  return new Set(code.match(/[A-Za-z_$][\w$]*/g) ?? []);
}

/**
 * Every identifier the code spells. Not this file: its exemptions are names
 * written down BECAUSE the code does not have them, and counting them would
 * let the list vouch for itself.
 */
const CODE_TOKENS = tokensOf(
  CODE.filter((path) => path !== 'vite/docClaims.test.ts')
    .map((path) => withoutComments(textOf(path), path))
    .join('\n'),
);

/**
 * SOMEBODY ELSE'S NAMES: every identifier in the type declarations of the
 * platform and of this repository's own dependencies, one level down.
 *
 * A document that says `canPlayType`, `EventSource` or Playwright's
 * `selectOption()` is naming something real that this repository never
 * spells, and a hand-kept list of those would be the kind of list that
 * rots. The declarations are the platform's own inventory - TypeScript's
 * `lib.dom.d.ts` is in them - so the list is the one somebody else keeps.
 * Declarations only: a dependency's private helpers are not API, and a
 * document naming one is exempted below by hand, with the reason.
 */
function dependencyTokens(): Set<string> {
  const manifest = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const direct = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];
  const tokens = new Set<string>();
  const seen = new Set<string>();
  const queue: (readonly [string, string, boolean])[] = direct.map((name) => [
    name,
    resolve(ROOT, 'node_modules', name),
    true,
  ]);
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.d\.[cm]?ts$/.test(entry.name)) {
        for (const token of readFileSync(full, 'utf8').match(/[A-Za-z_$][\w$]*/g) ?? [])
          tokens.add(token);
      }
    }
  };
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [, link, isDirect] = next;
    if (!existsSync(link)) continue;
    const real = realpathSync(link);
    if (seen.has(real)) continue;
    seen.add(real);
    walk(real);
    if (!isDirect) continue;
    const own = JSON.parse(readFileSync(resolve(real, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    // pnpm puts a package's own dependencies beside it, not inside it.
    const beside = resolve(real, '..', ...(basename(dirname(real)).startsWith('@') ? ['..'] : []));
    for (const dependency of Object.keys(own.dependencies ?? {})) {
      queue.push([dependency, resolve(beside, dependency), false]);
    }
  }
  return tokens;
}

const DEPENDENCY_TOKENS = dependencyTokens();

/** Every `localStorage` key the app spells, as a string literal in non-test code. */
const STORAGE_KEYS = new Set(
  CODE.filter((path) => path.startsWith('src/') && !/\.test\.tsx?$/.test(path)).flatMap((path) =>
    [...textOf(path).matchAll(/'(patchbay:[\w-]+:v\d+)'/g)].map((match) => match[1] ?? ''),
  ),
);
const isKnownName = (part: string): boolean => CODE_TOKENS.has(part) || DEPENDENCY_TOKENS.has(part);

/* ========================================================================== *
 * Rule 1 - a name in a document is a name in the code
 * ========================================================================== */

const FILE_LIKE = /\.(?:tsx?|m?js|cjs|md|json|css|py|html|toml|ya?ml)$/;

/**
 * Whether a code span is a file name, and if so, whether it resolves: from
 * the repository root, from the document's own directory, or - for a bare
 * name like `share.test.ts` - as some file's basename.
 */
export function missingFile(
  span: string,
  from: string,
  exists: (path: string) => boolean,
): boolean {
  const path = span
    .replace(/[?#].*$/, '')
    .replace(/:\d+(?::\d+)?$/, '')
    .replace(/^@\//, 'src/');
  if (/\s|\*|\{|<|\.\.\.|^https?:|^\.[\w.]+$/.test(path)) return false;
  if (!FILE_LIKE.test(path) && !/^(?:src|scripts|docs|vite|public|\.claude)\/./.test(path))
    return false;
  // A served path is resolved as one; joining it to a directory would turn
  // `/sw.js` into the root itself.
  if (path.startsWith('/')) return !exists(path);
  const candidates = [path, `${dirname(from)}/${path}`].map((candidate) => {
    const absolute = resolve(ROOT, candidate);
    return absolute.startsWith(ROOT + sep)
      ? absolute
          .slice(ROOT.length + 1)
          .split(sep)
          .join('/')
      : '';
  });
  return !candidates.some(exists);
}

/**
 * A path from the root or the document's directory, a bare basename, or a
 * trailing part of a path - `lib/text.ts`, `spec/loss-corpus.json` - which is
 * how the prose names a file when its directory is clear from the sentence.
 */
/**
 * WHAT THE BUILD WRITES, AND FROM WHAT. A document may name `dist/index.html`
 * - it is the file the harness and the skill read - but the name resolves
 * because its SOURCE is in the repository, never because a build happens to
 * be lying on this disk. That used to be the rule by accident: a fallback to
 * the filesystem found `dist/` on every machine that had built, and CI, which
 * runs the tests before the build, found three names missing on the first
 * push after this file landed and on every push since.
 */
export const BUILD_OUTPUTS: Readonly<Record<string, string>> = {
  'dist/index.html': 'index.html',
  'dist/sw.js': 'vite/service-worker.js',
};

/**
 * Whether a path is in the repository. Nothing here reads the disk: the one
 * list is `EVERY_FILE`, so the answer cannot depend on what the machine has
 * built, and a path that climbs out of the root - `/sw.js` did, to the root
 * itself, which exists - is simply not in it.
 */
export function existsIn(files: ReadonlySet<string>, path: string): boolean {
  // A served path: `/sw.js` is what the site answers, from public/ or the build.
  if (path.startsWith('/')) {
    const served = path.slice(1);
    return files.has(`public/${served}`) || existsIn(files, `dist/${served}`);
  }
  const bare = path.replace(/\/$/, '');
  const source = BUILD_OUTPUTS[bare];
  if (source !== undefined) return files.has(source);
  if (bare === '' || bare.startsWith('..')) return false;
  // An import specifier: `@/lib/zod` is src/lib/zod.ts.
  if (['.ts', '.tsx', '/index.ts'].some((suffix) => files.has(`${bare}${suffix}`))) return true;
  if (files.has(bare)) return true;
  for (const file of files) {
    if (file.startsWith(`${bare}/`) || file.endsWith(`/${bare}`) || basename(file) === bare)
      return true;
  }
  return false;
}

const existsInRepository = (path: string): boolean => existsIn(EVERY_FILE_SET, path);

/**
 * Whether a code span is an identifier this repository would define - camel
 * case, an underscore, a member access or a call - rather than a word, a
 * value or a UI string.
 */
export function identifierIn(span: string): readonly string[] | null {
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/.test(span)) return null;
  if (!/[a-z][A-Z]|_|\.|\(\)$/.test(span)) return null;
  // `payload.exe`, `holiday.png`: an example file name, not a member access.
  if (/\.(?:exe|pdf|png|jpe?g|webp|gif|mp4|mkv|webm|avi|mov|txt|csv|tsv|zip|wasm|bin)$/.test(span))
    return null;
  return span.replace(/\(\)$/, '').split('.');
}

/**
 * NAMES A CURRENT DOCUMENT MAY USE THAT THE CODE DOES NOT DEFINE, AND WHY.
 *
 * Two kinds. A platform or library name is somebody else's, and is correct
 * whether or not this repository spells it. A removed name is history, and a
 * document may record a removal - but the entry says where, so it is a
 * decision and not an oversight. Every entry must still be USED by a document
 * and still be absent from the code, or it fails as stale: an exemption
 * nobody needs is an exemption that will one day hide something.
 */
const NAMED_BUT_NOT_DEFINED: Readonly<Record<string, string>> = {
  // Somebody else's, and not in any declaration file.
  AdvanceStringIndex:
    'an abstract operation of the ECMAScript specification, which the regex README cites',
  NotReadableError: 'a DOMException name, which lib.dom.d.ts carries only as a string',
  deBG: "a private PNG chunk Playwright's Firefox writes, named where the image README measured it",
  gAMA: 'a PNG chunk type, which image-convert strips by re-encoding rather than by name',
  cHRM: 'a PNG chunk type, which image-convert strips by re-encoding rather than by name',
  column_N: 'the pattern of the names the CSV reader invents for a blank header, not one name',
  'doctor.json': "written by the skill's doctor into its gitignored evidence/ directory",
  // Removed on purpose, and named as history.
  jsonErrorPosition:
    'replaced in round sixteen by locateJsonSyntaxError; the matrix records, in the past tense, why its reason was false',
  'ffmpeg-core.js': "@ffmpeg/core's file, in the snapshot that decided not to ship it",
  'dev/lib/syntax.js:363':
    "a line of micromark-extension-gfm-autolink-literal, cited as upstream's behaviour",
  // Files that are not in the repository by design.
  'sw.js': 'the service worker the build writes into dist/, from vite/service-worker.js',
  'in.json': 'a yaml-test-suite case file, inside the committed fixture rather than beside it',
  'notes.json': 'an example file name in the file-input walkthrough',
  // The worked example in adding-a-tool.md: a tool that does not exist, on purpose.
  'src/tools/case-convert/index.ts': "adding-a-tool.md's worked example",
  'src/tools/case-convert/options.ts': "adding-a-tool.md's worked example",
  'src/tools/case-convert/case-convert.test.ts': "adding-a-tool.md's worked example",
  'src/tools/case-convert/README.md': "adding-a-tool.md's worked example",
  'case.ts': "adding-a-tool.md's worked example",
};

function namesNotDefined(document: string): readonly string[] {
  const missing: string[] = [];
  for (const span of codeSpans(textOf(document))) {
    if (span in NAMED_BUT_NOT_DEFINED) continue;
    if (missingFile(span, document, existsInRepository)) {
      missing.push(`\`${span}\` (no such file)`);
      continue;
    }
    if (document in DATED || FILE_LIKE.test(span)) continue;
    // A storage key is a string, not an identifier: it has to be one the code writes.
    if (/^patchbay:[\w-]+:v\d+$/.test(span)) {
      if (!STORAGE_KEYS.has(span)) missing.push(`\`${span}\` (no such storage key)`);
      continue;
    }
    const parts = identifierIn(span);
    if (parts !== null && !parts.every(isKnownName)) missing.push(`\`${span}\` (not in the code)`);
  }
  return [...new Set(missing)];
}

/** Whether an exemption is still needed: some document uses it, and it still does not resolve. */
function exemptionNeeded(name: string): boolean {
  const used = DOCUMENTS.some((document) => codeSpans(textOf(document)).includes(name));
  if (!used) return false;
  if (FILE_LIKE.test(name)) return !existsInRepository(name);
  const parts = identifierIn(name);
  return !(parts?.every(isKnownName) ?? false);
}

/**
 * The same rule over the prose half of code: a backticked name in a comment,
 * and any test file a comment names at all - "see commands.test.ts" was how
 * a comment pointed at tests that had never existed.
 */
function namesNotDefinedInComments(path: string): readonly string[] {
  const comments = commentsOf(textOf(path), path);
  const missing: string[] = [];
  for (const match of comments.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1] ?? '';
    if (span in NAMED_IN_COMMENTS) continue;
    if (missingFile(span, path, existsInRepository)) {
      missing.push(`\`${span}\` (no such file)`);
      continue;
    }
    if (FILE_LIKE.test(span) || /^_|_$|^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(span)) continue;
    const parts = identifierIn(span);
    if (parts !== null && !parts.every(isKnownName)) missing.push(`\`${span}\` (not in the code)`);
  }
  for (const match of comments.matchAll(/(?<![\w/.`-])([\w.-]+\.test\.tsx?)\b/g)) {
    const name = match[1] ?? '';
    if (!(name in NAMED_IN_COMMENTS) && !existsInRepository(name))
      missing.push(`${name} (no such test file)`);
  }
  return [...new Set(missing)];
}

/**
 * Names a comment may use that neither the code nor a declaration file
 * spells, and why. A snake_case name is not listed: it is a field of a
 * specification (`pic_width_in_mbs_minus1`, `stream_type`), which is how the
 * container readers cite the standard they parse, and this repository names
 * nothing of its own that way.
 */
const NAMED_IN_COMMENTS: Readonly<Record<string, string>> = {
  // Fields of the container and codec specifications, in their own spelling.
  AVCProfileIndication: 'a field of the AVCDecoderConfigurationRecord, ISO/IEC 14496-15',
  AVCLevelIndication: 'a field of the AVCDecoderConfigurationRecord, ISO/IEC 14496-15',
  lengthSizeMinusOne: 'a field of the AVCDecoderConfigurationRecord, ISO/IEC 14496-15',
  parallelismType: 'a field of the HEVCDecoderConfigurationRecord, ISO/IEC 14496-15',
  constantFrameRate: 'a field of the HEVCDecoderConfigurationRecord, ISO/IEC 14496-15',
  CodecPrivate: 'a Matroska element',
  biCompression: 'a field of the BITMAPINFOHEADER an AVI carries',
  biHeight: 'a field of the BITMAPINFOHEADER an AVI carries',
  wFormatTag: 'a field of the WAVEFORMATEX an AVI carries',
  frameLengthFlag: 'a field of the AAC AudioSpecificConfig, ISO/IEC 14496-3',
  dependsOnCoreCoder: 'a field of the AAC AudioSpecificConfig, ISO/IEC 14496-3',
  extensionFlag: 'a field of the AAC AudioSpecificConfig, ISO/IEC 14496-3',
  // A dependency's internals, named where a comment explains its behaviour.
  extractLeadingCheckbox: "mdast-util-gfm-task-list-item's private helper",
  stringifyKey: "the yaml package's private helper",
  findScalarTagByName: "the yaml package's private helper",
  rfc7520WithKeyOps: "a Wycheproof test group's name, in its JSON",
  // Examples and file names that are not files here.
  dataFooBar: 'the dataset spelling of an example attribute, data-foo-bar',
  'in.yaml': 'a yaml-test-suite case file, inside the committed fixture',
  'in.json': 'a yaml-test-suite case file, inside the committed fixture',
  'entry.yaml': 'the per-case file the PyYAML generator writes to a temporary directory',
  'notes.json': 'an example file name',
  'sw.js': 'the service worker the build writes into dist/',
  'index.test.tsx': "the file name the router plugin's ignore pattern exists to skip",
  'vite/client': "a module specifier - Vite's client types - not a path",
  NotReadableError: 'a DOMException name, which lib.dom.d.ts carries only as a string',
  deBG: "a private PNG chunk Playwright's Firefox writes",
  // History, and marked as history where it is written.
  enteredAt: 'a field of the instrumentation a harness measurement used, quoted with its result',
  panToReveal: 'removed when the keyboard inset replaced it; the comment is the reason why',
};

/* ========================================================================== *
 * Rule 2 - a harness section named anywhere is a harness section
 * ========================================================================== */

function harnessNamesNotDefined(path: string): readonly string[] {
  const prose = path.endsWith('.md') ? proseOf(textOf(path)) : commentsOf(textOf(path), path);
  const names = new Set(prose.match(/\bcheck[A-Z][A-Za-z]+\b/g) ?? []);
  return [...names].filter((name) => !CODE_TOKENS.has(name));
}

/* ========================================================================== *
 * Rule 3 - a count of something the code can count is counted
 * ========================================================================== */

const NUMBER_WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

/** `"six"`, `"Six"` or `"6"` as a number; `null` for anything else. */
export function numberFrom(word: string): number | null {
  const lower = word.toLowerCase();
  if (/^\d+$/.test(lower)) return Number(lower);
  const index = NUMBER_WORDS.indexOf(lower);
  return index === -1 ? null : index;
}

function countOf(pattern: RegExp, text: string): number {
  return [...text.matchAll(pattern)].length;
}

/** The length of an array literal `const NAME = [ ... ];`, counted by its entries. */
function arrayLength(source: string, name: string, entry: RegExp): number {
  const start = source.indexOf(`const ${name} = [`);
  if (start === -1) return -1;
  const body = source.slice(start, source.indexOf('];', start));
  return countOf(entry, body);
}

const TOOL_DIRECTORIES: readonly string[] = [
  ...new Set(
    FILES.filter((path) => /^src\/tools\/[^/]+\/index\.ts$/.test(path)).map(
      (path) => path.split('/')[2] ?? '',
    ),
  ),
];

interface Count {
  /** What is counted, in words, for the failure message. */
  readonly what: string;
  /** The true count, from the code. */
  readonly truth: () => number;
  /** Phrases that state it. Group 1 is the number, as a word or digits. */
  readonly phrases: readonly RegExp[];
}

/**
 * Each of these has been written down as a number in prose, and each is a
 * number the code already knows. Group 1 of each phrase is the claim.
 */
export const COUNTS: readonly Count[] = [
  {
    what: 'inline scripts in index.html (each hashed into the CSP)',
    truth: () => countOf(/<script(?![^>]*\bsrc=)[^>]*>/g, textOf('index.html')),
    phrases: [
      /\b(?:the|exactly|only)\s+(\w+)\s+inline\s+scripts?\b/gi,
      /\bshipping\s+(no)\s+inline\s+scripts\b/gi,
    ],
  },
  {
    what: 'style-src hashes csp-hash.ts writes (the `styleHashes` array)',
    truth: () => {
      const source = textOf('vite/plugins/csp-hash.ts');
      const line = /const styleHashes = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
      return countOf(/sha256\(/g, line);
    },
    phrases: [
      /\b(\w+)\s+exact\s+stylesheets\s+allowed\s+by\s+sha256\b/gi,
      /'self'\s+and\s+(?:exactly\s+)?(\w+)\s+hashes\b/gi,
      /\bexactly\s+(\w+)\s+hashes,\s+the\s+count\b/gi,
    ],
  },
  {
    what: 'budgets in scripts/check-bundle-budget.js',
    truth: () => countOf(/^const \w*BUDGET_BYTES = /gm, textOf('scripts/check-bundle-budget.js')),
    phrases: [
      /\b\w+\s+payloads\s+against\s+(\w+)\s+budgets\b/gi,
      /\bany\s+of\s+(\w+)\s+measured\s+payloads\b/gi,
    ],
  },
  {
    what: 'gates: the pnpm steps CI runs after installing',
    truth: () => countOf(/^\s+run: pnpm (?!install)/gm, textOf('.github/workflows/ci.yml')),
    phrases: [/\bthe\s+(\w+)\s+gates\b/gi, /\bCI\s+runs\s+all\s+(\w+)\b/g],
  },
  {
    what: 'sections in the SECTIONS list of scripts/cross-browser-check.mjs',
    truth: () =>
      arrayLength(textOf('scripts/cross-browser-check.mjs'), 'SECTIONS', /\bcheck[A-Z]\w*/g),
    phrases: [/\bthe\s+(\d+)\s+section\s+names\b/gi, /\bof\s+(\d+)\s+sections\b/gi],
  },
  {
    what: 'tools: directories under src/tools with an index.ts',
    truth: () => TOOL_DIRECTORIES.length,
    /*
     * Present tense only. "all nine tools" in a comment about what the port
     * audit removed is a sentence about the day it was written, and correct;
     * "this filters eight tools" is a sentence about today.
     */
    phrases: [
      /\b(\w+)\s+tools\s+that\s+run\b/gi,
      /\bfilters\s+(\w+)\s+tools\b/gi,
      /\blists\s+(\w+)\s+tools\b/gi,
      /\btoday's\s+(\w+)\s+tools\b/gi,
      /\bthe\s+(\w+)\s+tools\s+in\s+the\s+registry\b/gi,
      /\b\w+\s+of\s+the\s+(\w+)\s+tools\s+are\s+resident\b/gi,
    ],
  },
  {
    what: 'resident tools: those not declared with defineStreamingTool',
    truth: () =>
      TOOL_DIRECTORIES.filter(
        (tool) => !textOf(`src/tools/${tool}/index.ts`).includes('defineStreamingTool('),
      ).length,
    phrases: [/\b(\w+)\s+of\s+the\s+\w+\s+tools\s+are\s+resident\b/gi],
  },
];

/**
 * Text with the line prefixes prose wraps under - a quotation's `>`, a doc
 * comment's `*`, a line comment's `//` - blanked to spaces of the same width,
 * so a phrase broken across two lines still matches and every offset still
 * points at the line it came from.
 */
export function unwrapped(text: string): string {
  return text.replace(/^[ \t]*(?:>|\*(?!\/)|\/\/)/gm, (prefix) => ' '.repeat(prefix.length));
}

/** The checker's own examples of a wrong sentence are not claims. */
const THIS_FILE = 'vite/docClaims.test.ts';

interface Stated {
  readonly where: string;
  readonly phrase: string;
  readonly says: number | null;
}

function statementsOf(count: Count): readonly Stated[] {
  const found: Stated[] = [];
  for (const path of FILES) {
    if (path in DATED || path === THIS_FILE) continue;
    // Fences included: `--list  # the 53 section names` is a claim in a code block.
    const text = unwrapped(textOf(path));
    for (const phrase of count.phrases) {
      for (const match of text.matchAll(phrase)) {
        const line = text.slice(0, match.index).split('\n').length;
        found.push({
          where: `${path}:${line.toString()}`,
          phrase: match[0],
          says: numberFrom(match[1] ?? ''),
        });
      }
    }
  }
  return found;
}

/* ========================================================================== *
 * Rule 4, and the two markers
 * ========================================================================== */

/** A hand-written test count: `5,320 tests`. */
export const TEST_COUNT = /\b\d[\d,]*\s+tests\b/g;

export const UNVERIFIED = /<!--\s*unverified:([\s\S]*?)-->/g;
export const ASSERTED = /<!--\s*asserted:\s*([^›]+?)\s*›\s*([\s\S]*?)\s*-->/g;

/**
 * Whether an `asserted` marker resolves: the file exists and contains the
 * title as a string - a test's name, or for `scripts/cross-browser-check.mjs`
 * a check's label.
 */
function assertedResolves(file: string, title: string): boolean {
  const target = FILES.find((path) => path === file || path.endsWith(`/${file}`));
  if (target === undefined) return false;
  const quoted = title.replace(/^['"`]|['"`]$/g, '');
  return textOf(target).includes(quoted);
}

/* ========================================================================== *
 * The rules, against the repository
 * ========================================================================== */

describe('documented claims', () => {
  it('finds the documents, the code and the tools at all, so a green run means something', () => {
    expect(DOCUMENTS.length).toBeGreaterThan(20);
    expect(DOCUMENTS).toContain('.claude/skills/verify-patchbay/SKILL.md');
    expect(CODE_TOKENS.has('locateJsonSyntaxError')).toBe(true);
    expect(TOOL_DIRECTORIES.length).toBeGreaterThan(5);
    for (const path of Object.keys(DATED)) expect(DOCUMENTS).toContain(path);
  });

  it.each(DOCUMENTS)('%s names only files and identifiers that exist', (document) => {
    expect(namesNotDefined(document)).toEqual([]);
  });

  it('keeps no exemption nobody needs', () => {
    expect(Object.keys(NAMED_BUT_NOT_DEFINED).filter((name) => !exemptionNeeded(name))).toEqual([]);
    const comments = CODE.filter((path) => path !== THIS_FILE)
      .map((path) => commentsOf(textOf(path), path))
      .join('\n');
    const stale = Object.keys(NAMED_IN_COMMENTS).filter((name) => {
      if (!comments.includes(name)) return true;
      if (FILE_LIKE.test(name) || name.includes('/')) return existsInRepository(name);
      return (identifierIn(name) ?? [name]).every(isKnownName);
    });
    expect(stale).toEqual([]);
  });

  it('names only files and identifiers that exist, in every comment', () => {
    const dangling = CODE.filter((path) => path !== THIS_FILE).flatMap((path) =>
      namesNotDefinedInComments(path).map((name) => `${path}: ${name}`),
    );
    expect(dangling).toEqual([]);
  });

  it('names only harness sections that exist, in every document and every comment', () => {
    const dangling = FILES.filter((path) => !(path in DATED) && path !== THIS_FILE).flatMap(
      (path) => harnessNamesNotDefined(path).map((name) => `${path}: ${name}`),
    );
    expect(dangling).toEqual([]);
  });

  describe.each(COUNTS)('the count of $what', (count) => {
    it('is stated somewhere, so this check has not silently retired', () => {
      expect(statementsOf(count).length).toBeGreaterThan(0);
    });

    it('is the true count everywhere it is stated', () => {
      const truth = count.truth();
      expect(truth).toBeGreaterThan(0);
      const wrong = statementsOf(count)
        .filter((stated) => stated.says !== truth)
        .map(
          (stated) => `${stated.where}: "${stated.phrase}", and the code says ${truth.toString()}`,
        );
      expect(wrong).toEqual([]);
    });
  });

  it.each(CURRENT_DOCUMENTS)('%s writes no test count by hand', (document) => {
    expect([...proseOf(textOf(document)).matchAll(TEST_COUNT)].map((match) => match[0])).toEqual(
      [],
    );
  });

  it.each(DOCUMENTS)('%s gives every unverified claim its reason', (document) => {
    const reasons = [...textOf(document).matchAll(UNVERIFIED)].map((match) =>
      (match[1] ?? '').trim(),
    );
    expect(reasons.filter((reason) => reason.split(/\s+/).length < 4)).toEqual([]);
  });

  it.each(DOCUMENTS)('%s points every asserted claim at a test that exists', (document) => {
    const unresolved = [...textOf(document).matchAll(ASSERTED)]
      .filter((match) => !assertedResolves((match[1] ?? '').trim(), match[2] ?? ''))
      .map((match) => match[0]);
    expect(unresolved).toEqual([]);
  });
});

/* ========================================================================== *
 * The rules, against deliberate breaks
 *
 * Each rule is run here against a sentence written to be wrong, so that the
 * rules above passing means they looked and found nothing - not that they
 * could not have found anything.
 * ========================================================================== */

describe('the claim rules, against sentences written to be wrong', () => {
  it('reads code spans from prose and not from a fence', () => {
    expect(codeSpans('A `lossNotesOf` here.\n\n```ts\nconst `gone` = 1;\n```\n')).toEqual([
      'lossNotesOf',
    ]);
  });

  it('finds a file that does not exist, and passes one that does', () => {
    const exists = (path: string): boolean => path === 'src/lib/plural.ts';
    expect(missingFile('src/lib/plural.ts', 'README.md', exists)).toBe(false);
    expect(missingFile('src/lib/plurals.ts', 'README.md', exists)).toBe(true);
    expect(missingFile('no-such-file.test.ts', 'README.md', exists)).toBe(true);
    // A bare name resolves as any file's basename, and a partial path as a path's tail.
    expect(missingFile('docClaims.test.ts', 'README.md', existsInRepository)).toBe(false);
    expect(missingFile('lib/plural.ts', 'README.md', existsInRepository)).toBe(false);
    expect(missingFile('lib/plurals.ts', 'README.md', existsInRepository)).toBe(true);
    // An extension on its own is not a file.
    expect(missingFile('.ts', 'README.md', exists)).toBe(false);
    // Not a file name at all.
    expect(missingFile('2.1 MB PNG image', 'README.md', exists)).toBe(false);
  });

  // CI was red from the commit that added this file until round eighteen:
  // resolution fell back to the disk, which had a `dist/` on every machine
  // that had built and none on CI, where the tests run before the build.
  it('answers from the file list alone, never from what is on this disk', () => {
    const none = new Set<string>();
    // Both exist on this disk; neither is in the list.
    expect(existsIn(none, 'package.json')).toBe(false);
    expect(existsIn(none, 'dist/index.html')).toBe(false);
    // A build output resolves through its source, and only a declared one does.
    expect(existsIn(new Set(['index.html']), 'dist/index.html')).toBe(true);
    expect(existsIn(new Set(['index.html']), 'dist/nope.html')).toBe(false);
    expect(Object.values(BUILD_OUTPUTS).every((source) => existsInRepository(source))).toBe(true);
  });

  // `/sw.js` joined to the root resolved to the root itself, which exists,
  // so every name beginning with a slash passed on every machine.
  it('resolves a served path through public/ and the build, and fails one that is neither', () => {
    expect(missingFile('/sw.js', 'README.md', existsInRepository)).toBe(false);
    expect(missingFile('/_headers.json', 'README.md', existsInRepository)).toBe(true);
    expect(missingFile('/no-such-file.ts', 'README.md', existsInRepository)).toBe(true);
    expect(missingFile('../outside.ts', 'README.md', existsInRepository)).toBe(true);
  });

  it('treats a camel-case, dotted or called name as an identifier, and a word as a word', () => {
    expect(identifierIn('lossNotesOf')).toEqual(['lossNotesOf']);
    expect(identifierIn('OutputPort.presentation')).toEqual(['OutputPort', 'presentation']);
    expect(identifierIn('dispose()')).toEqual(['dispose']);
    expect(identifierIn('SERIALISER_WRAPPERS')).toEqual(['SERIALISER_WRAPPERS']);
    expect(identifierIn('output')).toBeNull();
    expect(identifierIn('Line endings: compare')).toBeNull();
  });

  it('does not let a comment vouch for a name the code lost', () => {
    const code =
      '/** `checkInspectorState` below asserts it. */\nasync function checkInspectorMotion() {}';
    const tokens = tokensOf(withoutComments(code, 'x.mjs'));
    expect(tokens.has('checkInspectorMotion')).toBe(true);
    expect(tokens.has('checkInspectorState')).toBe(false);
    // And a URL is not a comment.
    expect(
      tokensOf(withoutComments("const u = 'https://example.org/keptName';", 'x.ts')).has(
        'keptName',
      ),
    ).toBe(true);
  });

  it('reads a number written as a word or as digits', () => {
    expect(numberFrom('Six')).toBe(6);
    expect(numberFrom('53')).toBe(53);
    expect(numberFrom('several')).toBeNull();
  });

  it('catches the sentence that said one inline script when there were two', () => {
    const phrase = COUNTS[0]?.phrases[0] ?? /$^/;
    const said = [...'the comment stripper runs over the one inline script'.matchAll(phrase)];
    expect(said.map((match) => numberFrom(match[1] ?? ''))).toEqual([1]);
    expect(COUNTS[0]?.truth()).toBe(2);
  });

  it('catches a hand-written test count', () => {
    expect('5,320 tests across 131 files'.match(TEST_COUNT)).toEqual(['5,320 tests']);
    expect('the RFC 4648 test vectors'.match(TEST_COUNT)).toBeNull();
  });

  it('reads both markers', () => {
    const doc =
      'A claim.<!-- unverified: no engine exposes it --> Another.<!-- asserted: plural.test.ts › counts -->';
    expect([...doc.matchAll(UNVERIFIED)].map((match) => match[1]?.trim())).toEqual([
      'no engine exposes it',
    ]);
    expect([...doc.matchAll(ASSERTED)].map((match) => [match[1], match[2]])).toEqual([
      ['plural.test.ts', 'counts'],
    ]);
  });
});
