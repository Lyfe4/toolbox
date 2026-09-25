import type { ToolManifestEntry } from '@/features/registry';
import {
  isJsonArray,
  isJsonObject,
  type JsonValue,
  type OutputPort,
  type ToolOutputs,
  type ToolValue,
} from '@/features/registry/types';
import { binaryHead, binarySize } from '@/lib/binary';
import { counted, plural } from '@/lib/plural';
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
 * THE FIRST EXCEPTION IS ABOUT PROSE, AND WAS BEING APPLIED TO SYNTAX. Round
 * seven: `text` is the data type of a string, not a promise that a person
 * wrote it, and three ports carry a serialised document on it. Pretty-printed
 * JSON summarised as `[`, a YAML stream as `---`, every unified patch in the
 * product as `--- original`, and a table as its column names - each of them
 * the SAME STRING for every document of its kind, which is a summary carrying
 * no information about the result it names. A tool that serialises something
 * still has the something, so the port points at the sibling holding it and
 * the node prints that; see `OutputPort.measuredBy` and `summariseOutputs`.
 * Nothing here sniffs a format, because a Markdown file with front matter
 * opens `---` as well.
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
 *
 * TWO WORDINGS, because the tool does two things and only one of them is a
 * search. A replacement that matched nothing hands back the subject unchanged,
 * so `output` reads as an ordinary result and the node said so; `Nothing
 * replaced` is the whole point of putting this on a node's face.
 *
 * AND A `+` WHEN THE SCAN WAS STOPPED. `count` is a total when the scan ran to
 * the end and a LOWER BOUND when the two-second budget cut it off - `complete`
 * is the flag for exactly that, and it is in the payload already. The listing
 * says "the scan was stopped early, so there may be more" in its last line; a
 * node that has room for neither the line nor the doubt has room for the sign.
 */
function regexSummary(value: JsonValue): string | null {
  const count = numberAt(value, 'count');
  if (count === null) return null;

  const replacing = isJsonObject(value) && value.mode === 'replace';
  if (count === 0) return replacing ? 'Nothing replaced' : 'No matches';

  // `complete` is absent from a payload written before it existed, or by a
  // hand-edited share link; only an explicit `false` is a stopped scan.
  const partial = isJsonObject(value) && value.complete === false ? '+' : '';
  return replacing
    ? `${count.toString()}${partial} replaced`
    : `${count.toString()}${partial} ${plural(count, 'match', 'matches')}`;
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

  /*
   * `Identical` IS A CLAIM, AND THERE IS ONE WAY IT CAN BE FALSE.
   *
   * A byte order mark is removed when bytes are decoded at a document port, so
   * a file that had one and a file that did not compare equal and the node says
   * `Identical` - about two files that are not. The diff tool reports it beside
   * the rows, which is the panel; the node is where a chain gets read, and this
   * is the one summary in the set that asserts sameness rather than measuring
   * something.
   *
   * Not `lossSummary`, which reads `report`-presented ports: diff has no report
   * port, and giving it one to carry a single flag would be a third output on a
   * 224px node for a fact that belongs in the word it is contradicting.
   */
  const notes: JsonValue | undefined = value.notes;
  const endings: JsonValue | undefined =
    notes !== undefined && isJsonObject(notes) ? notes.byteOrderMark : undefined;
  const bomDiffers =
    endings !== undefined && isJsonObject(endings) && endings.original !== endings.changed;

  if (value.identical === true) return bomDiffers ? 'Identical · BOM differs' : 'Identical';

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
       *
       * From the value's HEAD rather than from the whole thing, which is what
       * keeps this synchronous now that a value's bytes may be on disk: the
       * sniff never looks past 4 kB, so the head gives the verdict the file
       * would have given.
       */
      const sniff = sniffBytes(binaryHead(value.data));
      return `${formatBytes(binarySize(value.data))} ${sniff.label}`;
    }

    case 'color': {
      const { r, g, b, a } = value.color;
      const hex = `#${channel(r)}${channel(g)}${channel(b)}`;
      return a >= 1 ? hex : `${hex} at ${Math.round(a * 100).toString()}%`;
    }
  }
}

/** One `warn` note, as the canvas needs it: what was lost, and where it went. */
export interface LossNote {
  /** The one line written for a person. */
  readonly title: string;
  /** The rest of the explanation. Not drawn on a node; the corpus reads it. */
  readonly body: string;
  /**
   * The ids of THIS tool's output ports the loss is in.
   *
   * Written by the tool - see `ToolNote.reaches` - rather than guessed here,
   * because the answer is not the same for every port of every tool.
   * `structured-data`'s `data` port holds the parsed SOURCE, so a loss in the
   * write half is not in it, and that port is the way AROUND the loss. A
   * canvas rule that assumed "the node lost something, so everything leaving
   * it is suspect" would put a warning on the workaround.
   *
   * Empty is possible and is not an error: it is what a report written before
   * this field existed, or by a hand-edited share link, produces. A loss that
   * names no port still prints on the node's own face - that is `lossSummary`,
   * and it is about the node - it simply does not travel, because nothing has
   * said where it went.
   */
  readonly reaches: readonly string[];
}

/**
 * Every `warn` note a node's run produced, read off its `report` ports.
 *
 * ONE READER FOR EVERY QUESTION. `lossSummary` asks "what does this node print
 * on its own face", `lossTrace` asks "what leaves it along a wire", and
 * `notePorts.test.ts` and `lossCorpus.test.ts` ask whether a loss is told at
 * all. Both tests had their own walk until round fifteen, and both had
 * drifted: neither dropped an empty title or an empty port id, which this
 * does - so a warn note no canvas would ever show counted as told. A second
 * walk of the same payload is a second thing to keep in step with the shape,
 * which is the mistake `lib/notes.ts` exists to have stopped making.
 */
export function lossNotesOf(
  entry: ToolManifestEntry,
  outputs: ToolOutputs | null,
): readonly LossNote[] {
  if (!outputs) return [];

  const found: LossNote[] = [];

  for (const port of entry.outputs) {
    if (port.presentation !== 'report') continue;
    const value = outputs[port.id];
    if (value?.type !== 'json') continue;
    const notes = isJsonObject(value.data) ? value.data.notes : undefined;
    if (notes === undefined || !isJsonArray(notes)) continue;

    for (const note of notes) {
      if (!isJsonObject(note)) continue;
      if (note.level !== 'warn') continue;
      const title = note.title;
      if (typeof title !== 'string' || title === '') continue;

      // `undefined` for a report written before this field existed, or by a
      // hand-edited share link. Not an error - see `LossNote.reaches`.
      const reaches: JsonValue | undefined = note.reaches;
      found.push({
        title,
        body: typeof note.body === 'string' ? note.body : '',
        reaches:
          reaches !== undefined && isJsonArray(reaches)
            ? reaches.filter((id): id is string => typeof id === 'string' && id !== '')
            : [],
      });
    }
  }

  return found;
}

/**
 * WHAT THE RUN COULD NOT CARRY, IF ANYTHING.
 *
 * A node summarises its FIRST output and nothing else, which is the right rule
 * for an answer and the wrong one for a caveat: a tool's losses are reported on
 * a `report`-presented port, and every one of those is the second or third
 * port. So "the nested values were written into the cells as JSON" was a
 * sentence the product really did produce, on a port nobody had to wire, and
 * nowhere a person standing in front of the canvas would ever see it.
 *
 * This is the same argument the JWT summary already won. A node in the middle
 * of a chain is exactly where nobody opens the panel, and a conversion whose
 * result reads as ordinary is one whose losses are invisible.
 *
 * ONLY `warn`, AND ONLY FROM A `report` PORT. Both halves are the point. The
 * level is a promise about what a note means (see lib/notes.ts) - `info` is
 * "here is what happened", `warn` is "this went in and did not come out" - and
 * the presentation is what separates a loss from a diagnostic. `regex-tester`
 * carries `warn` notes about the PATTERN on a `regex`-presented port, and
 * "your pattern has slashes around it" is advice, not a loss; putting it on a
 * node's face would be the note that cries wolf.
 */
export function lossSummary(entry: ToolManifestEntry, outputs: ToolOutputs | null): string | null {
  const titles = lossNotesOf(entry, outputs).map((note) => note.title);
  if (titles.length === 0) return null;

  /*
   * The first title in full, and a count for the rest. Two losses joined by a
   * separator are two half-sentences at 224px; one whole sentence and "+1
   * more" says that there is more without making the first one unreadable.
   */
  const [first, ...rest] = titles;
  if (first === undefined) return null;
  return clip(rest.length === 0 ? first : `${first} · +${rest.length.toString()} more`);
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
 *
 * UNLESS THAT PORT IS A SERIALISATION, in which case the node prints what the
 * document AMOUNTS TO and the serialisation stays the answer. Three ports are:
 * `structured-data` writes its document from the value on `data`, `diff`
 * renders its patch from the rows on `changes`, and `regex-tester` prints a
 * listing of what is on `matches`. Each of those siblings is measured already
 * - `2 items`, `+12 -3`, `47 matches` - and each of the three first lines was
 * a constant: `[`, `--- original`, and the subject handed straight back when a
 * replacement matched nothing.
 *
 * THE PORT SAYS SO, rather than this file guessing from the text. The format
 * is an OPTION on two of the three tools, so nothing static could name it, and
 * sniffing it would make the summary wrong for the first document that opens
 * `---` without being YAML. `measuredBy` is declared beside the port that
 * needs it and checked against the set in `ports.test.ts`.
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

  /*
   * A run produces every port its tool declares, so both lookups below succeed
   * for any result this app has actually computed. They are still checked,
   * because `ToolOutputs` is a record and the alternative is a non-null
   * assertion - and the honest fallback for "the measure did not arrive" is
   * the value itself, not silence.
   */
  const measure =
    port.measuredBy === undefined
      ? undefined
      : entry.outputs.find((candidate) => candidate.id === port.measuredBy);
  const measured = measure ? outputs[measure.id] : undefined;
  const summary =
    measure && measured
      ? summariseValue(measured, measure.presentation)
      : summariseValue(value, port.presentation);

  // The guess is the part that must survive, so it is the summary that gives
  // up room for it: a clip of the whole line would cut the guess off first.
  const guess = guessOf(entry, outputs);
  return guess === null ? summary : `${clip(summary, SUMMARY_LIMIT - guess.length - 3)} · ${guess}`;
}

/** A guess is a few words; a longer one is clipped so the result keeps its room. */
const GUESS_LIMIT = 40;

/**
 * A guess a tool says its answer rests on, which the answer itself gives no
 * hint of: a report's `guess`, read off its `report` ports.
 *
 * ONE WRITER TODAY - `structured-data`, when a file's NAME decided its format -
 * and the rule is about that kind of guess rather than that tool. Content
 * detection is not here: `JSON (detected)` is a guess about the text the node
 * was given, and the inspector's `Detected` says it. A name is evidence from
 * outside the document, and `3 items` read because a file was called `ids.csv`
 * looks exactly like `3 items` read from anything else, so the face says so
 * where nobody has to open anything. A loss still outranks it - the face is
 * `Lossy · …` then, and this stays in the accessible name with the summary.
 */
function guessOf(entry: ToolManifestEntry, outputs: ToolOutputs): string | null {
  for (const port of entry.outputs) {
    if (port.presentation !== 'report') continue;
    const value = outputs[port.id];
    if (value?.type !== 'json') continue;
    const guess = stringAt(value.data, 'guess');
    if (guess !== null) return clip(guess, GUESS_LIMIT);
  }
  return null;
}
