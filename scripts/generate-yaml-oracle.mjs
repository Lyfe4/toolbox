/**
 * Generates the YAML oracle fixture from the yaml-test-suite.
 *
 * The suite (https://github.com/yaml/yaml-test-suite) is the reference corpus
 * every YAML implementation is measured against. Each case carries an
 * `in.yaml`, and then either an `in.json` holding the value a conforming
 * parser must produce, or an `error` marker saying the document must be
 * refused. That is an EXTERNAL answer to the question this repository has so
 * far only asked itself, which is the whole reason for the file.
 *
 * The output is committed; nothing at test time reaches the network.
 *
 * Regenerate with:
 *
 *     node scripts/generate-yaml-oracle.mjs > src/tools/structured-data/spec/yaml-test-suite.json && pnpm format
 *
 * Prettier reformats the JSON, so the format step is part of regenerating
 * rather than an afterthought - without it `pnpm format:check` fails on a
 * fixture nobody edited.
 *
 * PINNED TO A TAG, NOT A BRANCH. `data` moves, and a fixture regenerated from
 * a moving reference is a fixture whose diff nobody can review. The tag below
 * is the suite's own release; bumping it is a deliberate edit with a diff to
 * read.
 *
 * REPRODUCIBILITY. codeload rebuilds the tarball on every request, so its
 * bytes are not stable and its checksum would be noise. The digest recorded in
 * the fixture is over the EXTRACTED content - every path and every byte, in
 * sorted order - which is stable and is what the cases are actually made of.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const SUITE_TAG = 'data-2022-01-17';
const SUITE_URL = `https://codeload.github.com/yaml/yaml-test-suite/tar.gz/refs/tags/${SUITE_TAG}`;

/* ========================================================================== *
 * A tar reader, because Node has none
 * ========================================================================== */

/**
 * Reads a ustar archive into path -> bytes.
 *
 * Only the fields this needs: the name, the size, and the type flag. Long
 * names (GNU `L` entries) do not occur in this archive - every path in it is
 * well under 100 characters - and an unexpected type flag is an error rather
 * than something skipped quietly, so a future archive that does use one is
 * noticed instead of silently producing fewer cases.
 *
 * The suite's `name/` directory is a wall of SYMLINKS - one readable name per
 * test, pointing at the four-character id. They carry no content, so they are
 * recognised and passed over; only regular files reach the map, and therefore
 * only regular files reach the digest.
 */
function readTar(bytes) {
  const files = new Map();
  let at = 0;

  while (at + 512 <= bytes.length) {
    const header = bytes.subarray(at, at + 512);
    // Two consecutive zero blocks end the archive.
    if (header.every((byte) => byte === 0)) break;

    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const sizeField = header.toString('ascii', 124, 136).replace(/[\0 ].*$/, '');
    const size = Number.parseInt(sizeField, 8);
    const type = header.toString('ascii', 156, 157);

    if (!Number.isInteger(size)) throw new Error(`tar: unreadable size for ${name}`);
    // 0 and NUL are regular files; 1 a hard link, 2 a symlink, 5 a directory,
    // g and x the pax headers git's archiver writes.
    if (!['0', '\0', '1', '2', '5', 'g', 'x'].includes(type)) {
      throw new Error(`tar: unsupported entry type ${JSON.stringify(type)} for ${name}`);
    }

    at += 512;
    if (type === '0' || type === '\0') files.set(name, bytes.subarray(at, at + size));
    at += Math.ceil(size / 512) * 512;
  }

  return files;
}

/* ========================================================================== *
 * A stream of JSON values
 * ========================================================================== */

/**
 * Splits `in.json` into one value per YAML document.
 *
 * A multi-document `in.yaml` gets a multi-value `in.json`: the values are
 * written one after another with nothing between them but whitespace, so
 * `JSON.parse` on the whole file fails and the file has to be scanned.
 *
 * Depth and string state are tracked rather than trying `JSON.parse` on
 * growing prefixes, because a prefix of `12` is `1`, which parses - so a
 * prefix scanner would split a number in half and produce two plausible values
 * that were never in the file.
 */
function readJsonStream(text) {
  const values = [];
  let at = 0;

  while (at < text.length) {
    while (at < text.length && /\s/.test(text[at])) at += 1;
    if (at >= text.length) break;

    const start = at;
    const opener = text[at];

    if (opener === '{' || opener === '[') {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (; at < text.length; at += 1) {
        const character = text[at];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') inString = true;
        else if (character === '{' || character === '[') depth += 1;
        else if (character === '}' || character === ']') {
          depth -= 1;
          if (depth === 0) {
            at += 1;
            break;
          }
        }
      }
    } else if (opener === '"') {
      let escaped = false;
      for (at += 1; at < text.length; at += 1) {
        const character = text[at];
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') {
          at += 1;
          break;
        }
      }
    } else {
      // A bare scalar: true, false, null or a number. It ends at whitespace.
      while (at < text.length && !/\s/.test(text[at])) at += 1;
    }

    values.push(JSON.parse(text.slice(start, at)));
  }

  return values;
}

/* ========================================================================== *
 * The archive
 * ========================================================================== */

const source = process.argv[2];
const archive = source
  ? await readFile(source)
  : Buffer.from(
      await fetch(SUITE_URL).then((response) => {
        if (!response.ok) throw new Error(`${SUITE_URL} answered ${String(response.status)}`);
        return response.arrayBuffer();
      }),
    );

const files = readTar(gunzipSync(archive));

// Everything under the single top-level directory the tarball wraps.
const prefix = `yaml-test-suite-${SUITE_TAG}/`;
const entries = [...files].filter(([name]) => name.startsWith(prefix));
if (entries.length === 0) throw new Error(`no entries under ${prefix}`);

const digest = createHash('sha256');
for (const [name, bytes] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  digest.update(name.slice(prefix.length));
  digest.update('\0');
  digest.update(bytes);
  digest.update('\0');
}

/* ========================================================================== *
 * The cases
 * ========================================================================== */

const decoder = new TextDecoder('utf8', { fatal: true });
const read = (path) => {
  const bytes = files.get(prefix + path);
  return bytes === undefined ? null : decoder.decode(bytes);
};

/** Every directory holding an `in.yaml`, which is what a case is. */
const ids = [...files.keys()]
  .filter((name) => name.startsWith(prefix) && name.endsWith('/in.yaml'))
  .map((name) => name.slice(prefix.length, -'/in.yaml'.length))
  .sort();

const cases = [];
for (const id of ids) {
  const yaml = read(`${id}/in.yaml`);
  const label = read(`${id}/===`)?.trim() ?? '';
  if (yaml === null) continue;

  const expectsError = files.has(`${prefix}${id}/error`);
  const json = read(`${id}/in.json`);

  if (expectsError) {
    cases.push({ id, label, yaml, error: true });
    continue;
  }

  /*
   * A case with neither an `error` marker nor an `in.json` is one the suite
   * describes only as an event stream. There is no JSON answer to compare
   * against, so it is recorded with `documents: null` and the test skips the
   * value comparison for it - counted rather than dropped, so the number of
   * cases the fixture cannot decide is visible.
   */
  cases.push({
    id,
    label,
    yaml,
    error: false,
    documents: json === null ? null : readJsonStream(json),
  });
}

const fixture = {
  generator: `yaml-test-suite ${SUITE_TAG}`,
  contentDigest: `sha256:${digest.digest('hex')}`,
  counts: {
    total: cases.length,
    error: cases.filter((entry) => entry.error).length,
    withJson: cases.filter((entry) => !entry.error && entry.documents !== null).length,
    eventStreamOnly: cases.filter((entry) => !entry.error && entry.documents === null).length,
  },
  cases,
};

process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
