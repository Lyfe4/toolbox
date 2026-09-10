import type { ToolManifestEntry } from '@/features/registry';
import {
  isJsonArray,
  isJsonObject,
  type JsonValue,
  type OutputPort,
  type ToolOutputs,
  type ToolValue,
} from '@/features/registry/types';
import { counted } from '@/lib/plural';
import { formatBytes, sniffBytes } from '@/lib/sniff';

/**
 * WHAT A NODE SAYS ABOUT ITS RESULT.
 *
 * A SUMMARY, NOT A PREVIEW, and the distinction is the whole design. A node is
 * 224px wide with two clamped lines of type; the question it has to answer is
 * "can I stop reading here", not "what exactly did this produce". The answer
 * to the second question is the inspector, one press away, where the real
 * views live.
 *
 * So every summary below is a MEASUREMENT of the result rather than a slice of
 * it - "47 matches", "2.1 MB PNG image", "+12 -3" - with two deliberate
 * exceptions:
 *
 *   - Plain text, where the first line IS the measurement. architecture.md's
 *     rule for the tool page is that text gets no view because "plain text is
 *     already the answer"; the same is true at 35 characters.
 *   - The conversion report, which already carries a one-line summary written
 *     for a person. Deriving a second one here would be a second wording to
 *     keep in step with the first, and the README has a section about what
 *     happens when this codebase words the same fact twice.
 *
 * And one summary that is not a measurement at all: an unverified JWT leads
 * with the verdict. A node in the middle of a chain is precisely where nobody
 * opens the panel, and a decoder whose result reads as ordinary is one that
 * makes a forgery look authoritative. See JwtView for the same argument at
 * full size.
 */

/** Longest summary this file will return, before CSS clamping. */
export const SUMMARY_LIMIT = 60;

/**
 * Truncates on a character count rather than a word boundary.
 *
 * The box clamps to two lines anyway, so this is not about fitting - it is
 * about not putting a 30 MB decoded document into a node's accessible name,
 * which is a string an assistive technology will read from end to end.
 */
function clip(text: string, limit = SUMMARY_LIMIT): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** The first line with anything on it, so a leading blank line is not "empty". */
function firstLine(text: string): string | null {
  for (const line of text.split('\n')) {
    if (line.trim() !== '') return line;
  }
  return null;
}

function numberAt(value: JsonValue, key: string): number | null {
  if (!isJsonObject(value)) return null;
  const found = value[key];
  return typeof found === 'number' && Number.isFinite(found) ? found : null;
}

function stringAt(value: JsonValue, key: string): string | null {
  if (!isJsonObject(value)) return null;
  const found = value[key];
  return typeof found === 'string' && found !== '' ? found : null;
}

/* -------------------------------------------------------------------------- *
 * The four presentation hints that carry a shape worth measuring
 * -------------------------------------------------------------------------- */

/**
 * `count`, never `listed`.
 *
 * They differ exactly when the listing was truncated, and the count is the one
 * that outlives the truncation - the same distinction the regex tool had to
 * fix once already, when it reported `count: 5000` for a listing that had been
 * cut short. A node saying "200 matches" for a pattern that found 5,000 is the
 * quiet kind of wrong this project keeps finding.
 */
function regexSummary(value: JsonValue): string | null {
  const count = numberAt(value, 'count');
  if (count === null) return null;
  return count === 0 ? 'No matches' : counted(count, 'match', 'matches');
}

/**
 * Additions and removals, which is what a diff IS.
 *
 * `identical` is reported as its own word rather than as "+0 -0". Two files
 * that differ only in the ways the options were told to ignore are a real and
 * interesting outcome - it is why the tool has those options - and a pair of
 * zeroes reads as "the tool did nothing" instead.
 */
function diffSummary(value: JsonValue): string | null {
  if (!isJsonObject(value)) return null;
  if (value.identical === true) return 'Identical';

  const stats: JsonValue | undefined = value.stats;
  if (stats === undefined) return null;
  const added = numberAt(stats, 'added');
  const removed = numberAt(stats, 'removed');
  if (added === null || removed === null) return null;

  // A minus sign, not a hyphen: the row markers in DiffView are the same pair.
  return `+${added.toString()} −${removed.toString()}`;
}

/** The verdict first, then the algorithm. See the note at the top. */
function jwtSummary(value: JsonValue): string | null {
  if (!isJsonObject(value)) return null;
  const signature: JsonValue | undefined = value.signature;
  if (signature === undefined || !isJsonObject(signature)) return null;

  const algorithm = stringAt(signature, 'algorithm') ?? 'unknown alg';
  return signature.verified === true ? `Verified · ${algorithm}` : `NOT VERIFIED · ${algorithm}`;
}

/** The report's own sentence, verbatim. See the note at the top. */
function reportSummary(value: JsonValue): string | null {
  return stringAt(value, 'summary');
}

/* -------------------------------------------------------------------------- *
 * The data types
 * -------------------------------------------------------------------------- */

/**
 * A JSON value with no presentation hint, described by its SHAPE.
 *
 * Nothing in an arbitrary JSON value can be relied on to be short, so nothing
 * is quoted from it. How many keys or how many rows is the fact that tells you
 * whether the thing you expected came out.
 */
function jsonSummary(value: JsonValue): string {
  if (isJsonArray(value)) return counted(value.length, 'item');
  if (isJsonObject(value)) return counted(Object.keys(value).length, 'key');
  if (value === null) return 'null';
  return clip(typeof value === 'string' ? value : JSON.stringify(value));
}

/** Two channels to hex, the notation everybody recognises at a glance. */
function channel(value: number): string {
  return Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, '0');
}

export function summariseValue(
  value: ToolValue,
  presentation?: OutputPort['presentation'],
): string {
  // The hint is checked first, for the same reason OutputView checks it first:
  // it exists precisely for values whose data type does not determine how to
  // read them. A miss falls through to the type, so a malformed payload gets a
  // shape rather than nothing.
  if (value.type === 'json') {
    const hinted =
      presentation === 'regex'
        ? regexSummary(value.data)
        : presentation === 'diff'
          ? diffSummary(value.data)
          : presentation === 'jwt'
            ? jwtSummary(value.data)
            : presentation === 'report'
              ? reportSummary(value.data)
              : null;
    if (hinted !== null) return clip(hinted);
  }

  switch (value.type) {
    case 'text': {
      const line = firstLine(value.text);
      // An empty result rendered as an empty summary is indistinguishable from
      // no summary at all, and "it ran and produced nothing" is a fact worth
      // one word - it is usually the surprise.
      return line === null ? (value.text === '' ? 'Empty' : 'Whitespace only') : clip(line);
    }

    case 'json':
      return clip(jsonSummary(value.data));

    case 'bytes': {
      /*
       * The SNIFFED label, never the declared one - the same rule the rest of
       * the app follows, and the reason `payload.zip` renamed to `photo.png`
       * cannot describe itself as an image here either.
       */
      const sniff = sniffBytes(value.bytes);
      return `${formatBytes(value.bytes.byteLength)} ${sniff.label}`;
    }

    case 'color': {
      const { r, g, b, a } = value.color;
      const hex = `#${channel(r)}${channel(g)}${channel(b)}`;
      return a >= 1 ? hex : `${hex} at ${Math.round(a * 100).toString()}%`;
    }
  }
}

/**
 * The one line a node prints once it has run.
 *
 * THE FIRST DECLARED OUTPUT, and only that one. Seven of the ten tools have
 * more than one output port, and a node that tried to summarise all of them
 * would be summarising none of them at 224px. The manifest's order is not
 * arbitrary - the first port is the tool's answer and the rest are its working
 * (`Parsed data`, `Changes`, `Matches`, `Details`, `Every notation`) - so
 * "the first output" and "the result" are the same thing by construction.
 *
 * The other ports are not hidden, they are one press away in the inspector,
 * which is the whole reason a node is allowed to say this little.
 */
export function summariseOutputs(
  entry: ToolManifestEntry,
  outputs: ToolOutputs | null,
): string | null {
  if (!outputs) return null;

  const port = entry.outputs[0];
  if (!port) return null;

  const value = outputs[port.id];
  if (!value) return null;

  return summariseValue(value, port.presentation);
}
