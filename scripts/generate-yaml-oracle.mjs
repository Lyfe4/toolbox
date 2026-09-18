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
 * An event stream, composed
 * ========================================================================== */

/**
 * The suite's `test.event` format, which is the answer for every case.
 *
 * `in.json` exists only where the value has a JSON form, which is why 29 cases
 * carried no expectation at all until this. The EVENT stream exists for all of
 * them, and it is a complete description of the node graph: what opened, what
 * closed, every scalar with the style it was written in, every anchor and every
 * alias. Reading it is therefore reading the suite's own answer - the same
 * external reference, in the only spelling it publishes for these cases.
 *
 * The grammar, in the order the fields appear:
 *
 *     +STR / -STR                       the stream
 *     +DOC [---] / -DOC [...]           a document, with its markers
 *     +MAP [{}] [&anchor] [<tag>]       a mapping, flow or block
 *     +SEQ [[]] [&anchor] [<tag>]       a sequence
 *     =VAL [&anchor] [<tag>] <style><content>
 *     =ALI *anchor
 *
 * where `<style>` is one of `:` plain, `"` double-quoted, `'` single-quoted,
 * `|` literal, `>` folded - and the style is not decoration: a plain `null` is
 * the null value and a quoted `"null"` is the four-letter string.
 */
function parseEventLine(line) {
  const space = line.indexOf(' ');
  return space === -1
    ? { op: line, rest: '' }
    : { op: line.slice(0, space), rest: line.slice(space + 1) };
}

/**
 * Undoes the escaping the event format applies to scalar content.
 *
 * Only what the corpus actually uses plus the obvious neighbours; an unknown
 * escape keeps its character rather than being dropped, so a corpus that grows
 * one produces a visibly wrong value rather than a quietly shortened one.
 */
function unescapeEventScalar(text) {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] !== '\\') {
      out += text[at];
      continue;
    }
    at += 1;
    const character = text[at];
    if (character === 'n') out += '\n';
    else if (character === 't') out += '\t';
    else if (character === 'r') out += '\r';
    else if (character === 'b') out += '\b';
    else if (character === '0') out += '\0';
    else if (character === '\\') out += '\\';
    else if (character === 'x') {
      out += String.fromCharCode(Number.parseInt(text.slice(at + 1, at + 3), 16));
      at += 2;
    } else if (character === 'u') {
      out += String.fromCharCode(Number.parseInt(text.slice(at + 1, at + 5), 16));
      at += 4;
    } else if (character === 'U') {
      out += String.fromCodePoint(Number.parseInt(text.slice(at + 1, at + 9), 16));
      at += 8;
    } else out += character;
  }
  return out;
}

/**
 * Reads the flow indicator, anchor and tag off the front of an event argument.
 *
 * ORDER MATTERS AND SO DOES GREED. An anchor name runs to the next space and
 * may contain anything: the corpus has `&:@*!$"<foo>:`, which holds what looks
 * like a tag. Reading the anchor first, to its space, is what stops that being
 * misread - a scanner that looked for `<` first would take the tag out of the
 * middle of a name.
 */
function eventProperties(rest) {
  let at = 0;
  let anchor = null;
  let tag = null;

  // `+MAP {}` and `+SEQ []` put the flow indicator before the properties.
  if (rest.startsWith('{}') || rest.startsWith('[]')) {
    at = 2;
    if (rest[at] === ' ') at += 1;
  }

  for (;;) {
    if (rest[at] === '&') {
      const space = rest.indexOf(' ', at);
      const end = space === -1 ? rest.length : space;
      anchor = rest.slice(at + 1, end);
      at = end + 1;
    } else if (rest[at] === '<') {
      const close = rest.indexOf('>', at);
      tag = rest.slice(at + 1, close);
      at = close + 1;
      if (rest[at] === ' ') at += 1;
    } else break;
  }

  return { anchor, tag, rest: rest.slice(at) };
}

/** Builds the node graph the events describe, with aliases pointing at nodes. */
function composeNodes(eventText) {
  const anchors = new Map();
  const documents = [];
  const stack = [];

  const place = (node, anchor) => {
    if (anchor !== null) anchors.set(anchor, node);
    const top = stack.at(-1);
    if (top === undefined) documents.push(node);
    else if (top.kind === 'seq') top.items.push(node);
    else top.pending.push(node);
  };

  for (const line of eventText.split('\n')) {
    if (line === '') continue;
    const { op, rest } = parseEventLine(line);

    if (op === '+STR' || op === '-STR' || op === '+DOC' || op === '-DOC') continue;

    if (op === '+MAP' || op === '+SEQ') {
      const { anchor, tag } = eventProperties(rest);
      const node =
        op === '+SEQ'
          ? { kind: 'seq', tag, items: [] }
          : { kind: 'map', tag, pending: [], pairs: [] };
      place(node, anchor);
      stack.push(node);
      continue;
    }

    if (op === '-MAP') {
      const node = stack.pop();
      // A mapping's children arrive as a flat key, value, key, value run.
      for (let at = 0; at + 1 < node.pending.length; at += 2) {
        node.pairs.push([node.pending[at], node.pending[at + 1]]);
      }
      continue;
    }

    if (op === '-SEQ') {
      stack.pop();
      continue;
    }

    if (op === '=ALI') {
      const target = anchors.get(rest.slice(1));
      if (target === undefined) throw new Error(`event stream aliases unknown anchor ${rest}`);
      place({ kind: 'alias', target }, null);
      continue;
    }

    if (op === '=VAL') {
      const { anchor, tag, rest: body } = eventProperties(rest);
      place(
        { kind: 'scalar', tag, style: body[0], value: unescapeEventScalar(body.slice(1)) },
        anchor,
      );
      continue;
    }

    throw new Error(`unknown event ${op}`);
  }

  return documents;
}

/** YAML 1.2's core schema, which is what an untagged plain scalar resolves by. */
const CORE_NULL = /^(?:|~|null|Null|NULL)$/;
const CORE_TRUE = /^(?:true|True|TRUE)$/;
const CORE_FALSE = /^(?:false|False|FALSE)$/;
const CORE_INT = /^[-+]?(?:0|[1-9][0-9]*)$/;
const CORE_HEX = /^[-+]?0x[0-9a-fA-F]+$/;
const CORE_OCT = /^[-+]?0o[0-7]+$/;
const CORE_FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const CORE_INF = /^[-+]?\.(?:inf|Inf|INF)$/;
const CORE_NAN = /^\.(?:nan|NaN|NAN)$/;

/** Thrown when the composed graph has no JSON form, carrying which one. */
class NotJson extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function scalarToJson(node) {
  const shorthand =
    node.tag === null
      ? null
      : node.tag.startsWith('tag:yaml.org,2002:')
        ? node.tag.slice('tag:yaml.org,2002:'.length)
        : 'local';

  if (shorthand === 'str' || shorthand === 'binary' || shorthand === 'local') return node.value;
  if (shorthand === 'null') return null;
  if (shorthand === 'bool') return CORE_TRUE.test(node.value);
  if (shorthand === 'int' || shorthand === 'float' || shorthand === null) {
    // A quoted or block scalar is a string whatever it spells.
    if (shorthand === null && node.style !== ':') return node.value;
    if (shorthand === null && CORE_NULL.test(node.value)) return null;
    if (shorthand === null && CORE_TRUE.test(node.value)) return true;
    if (shorthand === null && CORE_FALSE.test(node.value)) return false;
    if (CORE_HEX.test(node.value)) return Number.parseInt(node.value.replace('0x', ''), 16);
    if (CORE_OCT.test(node.value)) return Number.parseInt(node.value.replace('0o', ''), 8);
    if (CORE_INF.test(node.value)) throw new NotJson('infinity has no JSON spelling');
    if (CORE_NAN.test(node.value)) throw new NotJson('not-a-number has no JSON spelling');
    if (shorthand !== null || CORE_INT.test(node.value) || CORE_FLOAT.test(node.value)) {
      return Number(node.value);
    }
    return node.value;
  }

  return node.value;
}

/**
 * The composed graph as JSON, or the reason it has none.
 *
 * A KEY IS NAMED BY ITS OWN TEXT rather than by the value it resolves to. The
 * two differ in exactly one place and it is the place that matters: an empty
 * plain key resolves to `null`, and `JSON.stringify(null)` is the four letters
 * `null` - a key that was never in the document. Using the text gives `""`,
 * which is what the document says and what this tool produces. The rule is not
 * asserted from taste: it is what agrees with 278 of the suite's own answers,
 * and the previous rule agreed with 277.
 */
function nodeToJson(node, seen = new Set()) {
  if (node.kind === 'alias') {
    if (seen.has(node.target)) throw new NotJson('an alias makes the value cyclic');
    return nodeToJson(node.target, seen);
  }
  if (node.kind === 'scalar') return scalarToJson(node);
  if (seen.has(node)) throw new NotJson('an alias makes the value cyclic');

  const inside = new Set(seen).add(node);
  if (node.kind === 'seq') return node.items.map((item) => nodeToJson(item, inside));

  const shorthand =
    node.tag !== null && node.tag.startsWith('tag:yaml.org,2002:')
      ? node.tag.slice('tag:yaml.org,2002:'.length)
      : null;

  const out = {};
  for (const [key, value] of node.pairs) {
    const resolved = key.kind === 'alias' ? key.target : key;
    if (resolved.kind !== 'scalar') throw new NotJson('collection-key');
    const asJson = nodeToJson(resolved, inside);
    const name = typeof asJson === 'string' ? asJson : resolved.value;
    if (Object.hasOwn(out, name)) throw new NotJson('duplicate-key');
    out[name] = shorthand === 'set' ? null : nodeToJson(value, inside);
  }
  return out;
}

function composeFromEvents(eventText) {
  if (eventText === null) throw new Error('a case with no test.event');
  try {
    return { documents: composeNodes(eventText).map((node) => nodeToJson(node)), reason: null };
  } catch (error) {
    if (error instanceof NotJson) return { documents: null, reason: error.reason };
    throw error;
  }
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
   * describes only as an event stream. It used to be recorded with
   * `documents: null` and counted - visible, but undecided. It is decided now:
   * the suite ships a `test.event` for every case, and an event stream fixes
   * the node graph completely, so the value is COMPOSED from it below.
   *
   * Where that value has a JSON form it becomes `documents` like any other
   * case. Where it does not - a key that is itself a collection, two keys that
   * collide once they are JSON strings - the reason is recorded, and the
   * reason is itself an expectation: this tool has a documented refusal for
   * each one, and the test holds it to that refusal rather than to silence.
   */
  const composed = composeFromEvents(read(`${id}/test.event`));

  cases.push({
    id,
    label,
    yaml,
    error: false,
    documents:
      json !== null
        ? readJsonStream(json)
        : composed.documents === null
          ? null
          : composed.documents,
    ...(json === null
      ? { fromEvents: true, ...(composed.reason === null ? {} : { reason: composed.reason }) }
      : {}),
  });
}

/* ========================================================================== *
 * The composer, and the 278 answers that say it is right
 * ========================================================================== */

/*
 * A composer is code this repository wrote, which is the weakest kind of
 * evidence there is - so it is not trusted on the 29 cases it exists for until
 * it has reproduced the 279 the suite answers ITSELF. Every case that carries
 * an `in.json` is composed from its events too and compared; the script refuses
 * to write a fixture if more than the one known ordering difference disagrees.
 *
 * RR7F is that one. Its `in.json` prints an explicit `? d` key before `a`,
 * and JSON objects are unordered, so neither spelling is wrong - the oracle
 * test has said so about the same case since round two.
 */
const ORDERING_ONLY = new Set(['RR7F']);

let agreed = 0;
const disagreed = [];
for (const id of ids) {
  const json = read(`${id}/in.json`);
  if (json === null || files.has(`${prefix}${id}/error`)) continue;
  const composed = composeFromEvents(read(`${id}/test.event`));
  const expected = readJsonStream(json);
  if (JSON.stringify(composed.documents) === JSON.stringify(expected)) agreed += 1;
  else if (!ORDERING_ONLY.has(id)) {
    disagreed.push(`${id}: composed ${JSON.stringify(composed.documents)} vs ${json.trim()}`);
  }
}

if (disagreed.length > 0) {
  throw new Error(
    `the event composer disagrees with in.json on ${String(disagreed.length)} case(s):\n  ${disagreed.join('\n  ')}`,
  );
}

if (agreed < 250) {
  throw new Error(`the event composer only reproduced ${String(agreed)} of the suite's answers`);
}

const fixture = {
  generator: `yaml-test-suite ${SUITE_TAG}`,
  contentDigest: `sha256:${digest.digest('hex')}`,
  counts: {
    total: cases.length,
    error: cases.filter((entry) => entry.error).length,
    withJson: cases.filter((entry) => !entry.error && entry.documents !== null).length,
    /** Cases the suite answers only as an event stream - all of them, now. */
    fromEvents: cases.filter((entry) => entry.fromEvents === true).length,
    /** Of those, the ones whose composed value HAS a JSON form. */
    fromEventsWithValue: cases.filter(
      (entry) => entry.fromEvents === true && entry.documents !== null,
    ).length,
    /** And the ones whose composed value does not, by the reason it does not. */
    fromEventsByReason: Object.fromEntries(
      [...new Set(cases.filter((entry) => entry.reason !== undefined).map((e) => e.reason))]
        .sort()
        .map((reason) => [
          reason,
          cases.filter((entry) => entry.reason === reason).map((entry) => entry.id),
        ]),
    ),
    /**
     * How many of the suite's OWN answers the composer reproduced, which is the
     * only reason to believe it about the cases the suite does not answer.
     */
    composerAgreedWithJson: agreed,
    eventStreamOnly: cases.filter((entry) => !entry.error && entry.documents === null).length,
  },
  cases,
};

process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
