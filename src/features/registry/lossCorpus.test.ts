import { describe, expect, it } from 'vitest';

import { loadTool } from './loader';
import { TOOL_MANIFEST, type ToolId, type ToolManifestEntry } from './manifest';
import corpus from './spec/loss-corpus.json';
import {
  isJsonArray,
  isJsonObject,
  type JsonValue,
  type ToolOutputs,
  type ToolRunContext,
} from './types';
// The document itself, as text. `?raw` rather than `node:fs`, because the
// browser project deliberately has no Node types - see tsconfig.app.json.
import matrixDoc from '../../../docs/conversion-matrix.md?raw';

/**
 * THE INSTRUMENT THE SILENT-LOSS COUNT NEVER HAD.
 *
 * The count has been wrong twice, for the same reason both times, and the
 * reason is not that somebody miscounted. It is that `lossy, told` was a
 * verdict WRITTEN BY HAND in a table: round three reported zero silent losses
 * and round four found two; rounds four to seven reported zero and round eight
 * found seventeen, five of them in cells the same document was carrying as
 * `lossy, told`. A third attempt at an absolute number over a hand-written
 * list would fail in exactly the same way, because nothing anywhere was asking
 * the tools.
 *
 * So the number is derived here instead, and it has three properties the old
 * one did not:
 *
 *   1. IT IS A RATIO. `spec/loss-corpus.json` is the denominator - one
 *      document per row of the table in `docs/test-findings.md`, each with the
 *      note that row must produce. It starts mostly red. A denominator is a
 *      thing somebody can add to; an absolute zero is a thing somebody can
 *      only agree with.
 *   2. THE VERDICT IS MEASURED, NOT READ. Every case is RUN, and a row may say
 *      `lossy, told` only when a `warn` note on a `report`-presented port
 *      really carries it. A row whose note stops firing goes back to
 *      `lossy, silent` by itself, and the ratio falls.
 *   3. THE DOCUMENT CANNOT DRIFT FROM IT. The block between the
 *      `loss-corpus` markers in `docs/conversion-matrix.md` is GENERATED here
 *      and compared, so the sentence a reader sees is the sentence the tools
 *      produced on the run that published it.
 *
 * WHAT IT DOES NOT CLAIM. It is not a second opinion about what is lossy - the
 * seventeen rows came from running the real tools by hand and reading their
 * output, and this file inherits every one of those judgements. What it
 * measures is narrower and is the thing that was missing: whether the loss is
 * SAID.
 */

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

interface Expectation {
  readonly titleContains: string;
  readonly mentions: readonly string[];
}

interface CorpusCase {
  readonly row: number;
  readonly id: string;
  readonly loss: string;
  readonly cell: string;
  readonly tool: string;
  readonly options: Record<string, unknown>;
  /** The document that loses something, or null for a row nothing here can run. */
  readonly input: string | null;
  /** A document of the same shape that loses nothing. The negative control. */
  readonly clean: string | null;
  readonly expect: Expectation;
  readonly whyNoCase?: string;
  /**
   * Why this row's `expect` is not the one the round that WROTE the row asked
   * for.
   *
   * Declared rather than left as an unread key, because a re-specified
   * expectation is the one edit to this file that can quietly turn a row
   * green. Row 13 is the case: round nine's expectation asked a census of
   * NAMES for a fact about content.
   */
  readonly whyThisExpectation?: string;
}

interface ZeroReport {
  readonly reported: string;
  readonly foundBy: string;
  readonly found: number;
}

interface Corpus {
  readonly roundsThatReportedZero: readonly ZeroReport[];
  readonly cases: readonly CorpusCase[];
}

const { cases, roundsThatReportedZero } = corpus as unknown as Corpus;

/*
 * Read through the DECLARED type rather than off the const literal. The
 * literal's inferred type has no `presentation` key on the ports that lack
 * one, so a filter on it would not compile - the same move `notePorts.test.ts`
 * and `registry.test.ts` both make, and for the same reason: it keeps these
 * checks guards that survive the manifest changing.
 */
const MANIFEST: readonly ToolManifestEntry[] = TOOL_MANIFEST;

const VERDICTS = {
  told: 'lossy, told',
  silent: 'lossy, silent',
  unverified: 'not verified',
} as const;

type Verdict = (typeof VERDICTS)[keyof typeof VERDICTS];

/**
 * Every `warn` note a run produced, read off its `report` ports.
 *
 * The same walk `lossSummary` and `notePorts.test.ts` make, for the same
 * reason: a note the canvas cannot see is not a note the user was told.
 */
function warnNotes(
  toolId: string,
  outputs: ToolOutputs,
): readonly { title: string; body: string }[] {
  const entry = MANIFEST.find((tool) => tool.id === toolId);
  if (!entry) return [];

  const found: { title: string; body: string }[] = [];
  for (const port of entry.outputs) {
    if (port.presentation !== 'report') continue;
    const value = outputs[port.id];
    if (value?.type !== 'json' || !isJsonObject(value.data)) continue;
    const notes: JsonValue | undefined = value.data.notes;
    if (notes === undefined || !isJsonArray(notes)) continue;

    for (const note of notes) {
      if (!isJsonObject(note) || note.level !== 'warn') continue;
      found.push({
        title: typeof note.title === 'string' ? note.title : '',
        body: typeof note.body === 'string' ? note.body : '',
      });
    }
  }
  return found;
}

async function run(entry: CorpusCase, text: string): Promise<ToolOutputs> {
  const tool = await loadTool(entry.tool as ToolId);
  const result = await tool.run({
    inputs: { input: { type: 'text', text } },
    options: { ...(tool.defaultOptions as Record<string, unknown>), ...entry.options },
    context,
  });
  if (!result.ok) {
    throw new Error(`${entry.id}: the tool refused this document - ${result.error.message}`);
  }
  return result.value;
}

/**
 * Case-insensitive, because a title may legitimately start a sentence and the
 * corpus names things the way a person writes them.
 */
function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * A note ABOUT THIS ROW'S SUBJECT, whatever it says about it.
 *
 * Title only, and that is the whole reason the two halves are separate
 * functions. The first draft of this file used one matcher for both
 * directions, and the negative control it produced did not work: with
 * `mentions` in the condition, a note that fired on EVERY colour still failed
 * to match the clean run, because the note it wrote there named the clean
 * colour rather than the dirty one. It was found by making the clamp note
 * unconditional and watching the control pass.
 *
 * A note that cries wolf is a note about the right subject on the wrong
 * document, so the control has to ask about the subject alone.
 */
function aboutTheSameThing(
  notes: readonly { title: string; body: string }[],
  expected: Expectation,
): { title: string; body: string } | null {
  return notes.find((note) => contains(note.title, expected.titleContains)) ?? null;
}

/** The note this row demands: about the subject, AND naming what it did. */
function matchingNote(
  notes: readonly { title: string; body: string }[],
  expected: Expectation,
): { title: string; body: string } | null {
  const whole = (note: { title: string; body: string }): string => `${note.title} ${note.body}`;
  return (
    notes.find(
      (note) =>
        contains(note.title, expected.titleContains) &&
        expected.mentions.every((mention) => contains(whole(note), mention)),
    ) ?? null
  );
}

/** Runs one case and returns what the tools actually did with it. */
async function measure(entry: CorpusCase): Promise<Verdict> {
  if (entry.input === null) return VERDICTS.unverified;
  const notes = warnNotes(entry.tool, await run(entry, entry.input));
  return matchingNote(notes, entry.expect) === null ? VERDICTS.silent : VERDICTS.told;
}

/* ========================================================================== *
 * The corpus itself
 * ========================================================================== */

describe('the loss corpus', () => {
  it('holds one case per row of the silent-loss table, numbered without gaps', () => {
    expect(cases.length).toBeGreaterThanOrEqual(17);
    expect(cases.map((entry) => entry.row)).toEqual(cases.map((_entry, index) => index + 1));
  });

  it('gives every case a unique id and a tool this app actually has', () => {
    const ids = cases.map((entry) => entry.id);
    expect([...new Set(ids)]).toHaveLength(ids.length);

    const known = new Set<string>(MANIFEST.map((tool) => tool.id));
    expect(cases.filter((entry) => !known.has(entry.tool)).map((entry) => entry.id)).toEqual([]);
  });

  /*
   * A case with no negative control is a case that can only ever say "a note
   * fired", never "a note fired for the right document". Round six's lesson
   * written into the shape of the file rather than into a reviewer's memory.
   */
  it('gives every runnable case a clean document to be the control', () => {
    const missing = cases
      .filter((entry) => entry.input !== null && (entry.clean ?? '') === '')
      .map((entry) => entry.id);
    expect(missing).toEqual([]);
  });

  it('states a reason for any row it cannot run', () => {
    const unexplained = cases
      .filter((entry) => entry.input === null && (entry.whyNoCase ?? '') === '')
      .map((entry) => entry.id);
    expect(unexplained).toEqual([]);
  });

  /*
   * The sentence printed beside the ratio is a COUNT OF ROUNDS, and it is the
   * one number in this area that has never been wrong. It is kept in the
   * corpus so that adding the next episode is an edit to data.
   */
  it('remembers every round that reported zero', () => {
    expect(roundsThatReportedZero.length).toBeGreaterThanOrEqual(2);
    for (const episode of roundsThatReportedZero) {
      expect(episode.found, `${episode.reported} was followed by nothing`).toBeGreaterThan(0);
    }
  });
});

/* ========================================================================== *
 * The negative control, per case
 * ========================================================================== */

describe('a document that loses nothing produces no note about losing something', () => {
  it.each(cases.filter((entry) => entry.clean !== null))(
    'row $row, $id',
    async (entry: CorpusCase) => {
      const clean = entry.clean ?? '';
      /*
       * The control has to RUN. A refusal produces no notes either, and a
       * control that silently stopped being a control is exactly the failure
       * this whole file exists to make loud.
       */
      const outputs = await run(entry, clean);
      expect(Object.keys(outputs).length).toBeGreaterThan(0);

      const note = aboutTheSameThing(warnNotes(entry.tool, outputs), entry.expect);
      expect(
        note === null ? null : `${note.title} :: ${note.body}`,
        `"${clean}" loses nothing, so nothing should say it did`,
      ).toBeNull();
    },
  );
});

/* ========================================================================== *
 * The derived verdict, and the document that prints it
 * ========================================================================== */

const BEGIN = '<!-- loss-corpus:begin -->';
const END = '<!-- loss-corpus:end -->';

function ratioSentence(told: number, total: number): string {
  return `**${told.toString()} of ${total.toString()}** documented losses are told.`;
}

const TIMES: Readonly<Record<number, string>> = { 1: 'once', 2: 'twice', 3: 'three times' };

function roundsSentence(episodes: readonly ZeroReport[]): string {
  const found = episodes.map((episode) => `${episode.foundBy} found ${episode.found.toString()}`);
  const times = TIMES[episodes.length] ?? `${episodes.length.toString()} times`;
  return `A round has reported zero silent losses ${times}, and every time the next round to look found more — ${found.join(', and ')}.`;
}

/** The block the matrix prints, built from what the tools just did. */
function renderBlock(verdicts: readonly { entry: CorpusCase; verdict: Verdict }[]): string {
  const told = verdicts.filter((row) => row.verdict === VERDICTS.told).length;

  const lines = [
    ratioSentence(told, verdicts.length),
    '',
    roundsSentence(roundsThatReportedZero),
    '',
    '| # | Loss | Where the cell is | Tool | Verdict |',
    '| --- | --- | --- | --- | --- |',
    ...verdicts.map(
      ({ entry, verdict }) =>
        `| ${entry.row.toString()} | ${entry.loss} | ${entry.cell} | \`${entry.tool}\` | **${verdict}** |`,
    ),
  ];

  return lines.join('\n');
}

/**
 * Both sides through the same sieve before they are compared.
 *
 * Prettier owns the formatting of that table once it is in the file - it pads
 * every cell to the width of its column - so comparing the bytes would make
 * this test fail on formatting rather than on meaning. Cells are trimmed and
 * blank lines dropped; nothing that carries a verdict survives the
 * normalisation.
 */
function canonical(block: string): string {
  return block
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) =>
      line.trim().startsWith('|')
        ? line
            .trim()
            .split('|')
            .map((cell) => cell.trim().replace(/^-+$/u, '-'))
            .join('|')
        : line.trim(),
    )
    .filter((line) => line !== '')
    .join('\n');
}

describe('lossy, told is derived from the corpus rather than written down', () => {
  it('runs every case and prints the ratio the matrix carries', async () => {
    const verdicts: { entry: CorpusCase; verdict: Verdict }[] = [];
    for (const entry of cases) {
      verdicts.push({ entry, verdict: await measure(entry) });
    }

    const block = renderBlock(verdicts);

    const start = matrixDoc.indexOf(BEGIN);
    const end = matrixDoc.indexOf(END);
    expect(start, `${BEGIN} is missing from docs/conversion-matrix.md`).toBeGreaterThan(-1);
    expect(end, `${END} is missing from docs/conversion-matrix.md`).toBeGreaterThan(start);

    const printed = matrixDoc.slice(start + BEGIN.length, end);

    /*
     * THE FAILURE MESSAGE IS THE FIX. A round that changes what a tool says
     * changes this block, and the diff vitest prints IS the replacement - so
     * the document is updated by pasting rather than by counting again, which
     * is the step both wrong counts came from.
     */
    expect(
      canonical(printed),
      'docs/conversion-matrix.md no longer prints what the tools do. Replace the block between the loss-corpus markers with the expected text below.',
    ).toBe(canonical(block));
  });

  /*
   * And the claim in the other direction, which is the one that would have
   * caught the two wrong cells: a row the corpus measures as silent may not be
   * sitting in the matrix under a `lossy, told` verdict.
   *
   * It is asserted against this file's own output rather than against the
   * prose cells, because the prose cells are what the block above replaces as
   * the authority. The test that keeps them honest is the comparison above.
   */
  it('never reports a told row for a tool with nowhere to tell it', () => {
    const reporting = new Set<string>(
      MANIFEST.filter((tool) => tool.outputs.some((port) => port.presentation === 'report')).map(
        (tool) => tool.id,
      ),
    );

    const unsayable = cases
      .filter((entry) => entry.input !== null && !reporting.has(entry.tool))
      .map((entry) => entry.id);

    expect(
      unsayable,
      'a tool with no report port cannot reach the matrix definition of `lossy, told`',
    ).toEqual([]);
  });
});
