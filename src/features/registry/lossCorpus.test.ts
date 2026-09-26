import { describe, expect, it } from 'vitest';

import { lossNotesOf, type LossNote } from '@/features/canvas/resultSummary';

import { loadTool } from './loader';
import { TOOL_MANIFEST, type ToolId, type ToolManifestEntry } from './manifest';
import corpus from './spec/loss-corpus.json';
import matrixDoc from '../../../docs/conversion-matrix.md?raw';

import type { ToolOutputs, ToolRunContext } from './types';
// The document itself, as text. `?raw` rather than `node:fs`, because the
// browser project deliberately has no Node types - see tsconfig.app.json.

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
  /** What `check:browsers` holds this row to on /tools and on a node. See `drawnNote`. */
  readonly drawn: Drawn;
}

/**
 * The HARNESS's half of a row, kept here so there is one list of rows.
 *
 * `scripts/cross-browser-check.mjs` reads this file and drives every row in two
 * engines; before round twenty-three five sections listed the rows a second
 * time by hand, and the copy had drifted - row 3 was in none of them. This test
 * holds the data the harness reads to the tools, so a phrase no tool writes or
 * a label no page shows fails here, in `pnpm test`, rather than as a red row in
 * a browser nobody has run yet.
 */
interface Drawn {
  /** The tool page's options, as the page labels them: field label to choice label. */
  readonly choose: Readonly<Record<string, string>>;
  readonly says?: readonly string[];
  readonly unsaid?: readonly string[];
  readonly face?: string;
  readonly spoken?: string;
  readonly outputLacks?: readonly string[];
  /** The clean document draws no note at all, of any level. */
  readonly quiet?: boolean;
  readonly controls?: readonly { readonly input: string; readonly quiet: boolean }[];
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
 * Every `warn` note a run produced, read by the canvas's own reader - a note
 * the canvas cannot see is not a note the user was told.
 */
function warnNotes(toolId: string, outputs: ToolOutputs): readonly LossNote[] {
  const entry = MANIFEST.find((tool) => tool.id === toolId);
  return entry ? lossNotesOf(entry, outputs) : [];
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

/**
 * Every document a row says loses nothing: its `clean`, and each of the
 * harness's sharper controls - `"2024": launched` beside `year: launched`, a
 * header its author quoted, the same key in two sibling objects. They were the
 * harness's alone until round twenty-three; asked here too, they hold the
 * payload as well as the page.
 */
const CONTROLS = cases.flatMap((entry) =>
  [
    { input: entry.clean, quiet: entry.drawn.quiet === true },
    ...(entry.drawn.controls ?? []),
  ].flatMap(({ input, quiet }, index) =>
    input === null
      ? []
      : [
          {
            entry,
            text: input,
            quiet,
            which: index === 0 ? 'clean' : `control ${index.toString()}`,
          },
        ],
  ),
);

/**
 * How many notes of ANY level a run's report ports carry. A `quiet` control is
 * held to none at all - the old checks' "draws no note at all", which is
 * stronger than "no warning about the subject" and was what they asserted.
 */
function noteCount(toolId: string, outputs: ToolOutputs): number {
  const entry = MANIFEST.find((tool) => tool.id === toolId);
  let count = 0;
  for (const port of entry?.outputs ?? []) {
    if (port.presentation !== 'report') continue;
    const value = outputs[port.id];
    if (value?.type !== 'json' || typeof value.data !== 'object' || value.data === null) continue;
    const notes = (value.data as { notes?: unknown }).notes;
    if (Array.isArray(notes)) count += notes.length;
  }
  return count;
}

describe('a document that loses nothing produces no note about losing something', () => {
  it.each(CONTROLS)('row $entry.row, $entry.id, $which', async ({ entry, text: clean, quiet }) => {
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
    if (quiet) expect(noteCount(entry.tool, outputs), 'a quiet control carries no note').toBe(0);
  });
});

/* ========================================================================== *
 * The harness's half of each row
 * ========================================================================== */

/** The first output port's text: what the tool page shows as `<name> Converted`. */
function answerOf(entry: CorpusCase, outputs: ToolOutputs): string {
  const port = MANIFEST.find((tool) => tool.id === entry.tool)?.outputs[0];
  const value = port === undefined ? undefined : outputs[port.id];
  return value?.type === 'text' ? value.text : '';
}

describe('what check:browsers holds each row to', () => {
  const runnable = cases.filter((entry) => entry.input !== null);

  /*
   * WHAT `checkLossCorpus` CAN READ, held where a row's author runs the tests.
   *
   * The harness finds a tool's answer by the accessible name `<Tool name>
   * Converted` and reads it as a text box's value - a convention the four
   * tools with rows happened to share, and one that was written down nowhere
   * until round twenty-four. A row for any other tool used to fail only in a
   * browser run, as every positive going red at once with `output` null. Now it
   * fails here, naming the port. image-convert's first output is labelled
   * `Converted` too, and is bytes drawn as an image: the label alone is not the
   * contract.
   */
  it.each([...new Set(runnable.map((entry) => entry.tool))])(
    '%s: its answer is where the harness reads it, a text box labelled Converted',
    (tool) => {
      const first = TOOL_MANIFEST.find((entry) => entry.id === tool)?.outputs[0];
      expect(first?.label, `${tool}'s first output`).toBe('Converted');
      expect(first?.types, `${tool}'s first output`).toContain('text');
      const view = first !== undefined && 'presentation' in first ? first.presentation : undefined;
      expect(view, `${tool}'s first output is drawn by a view`).toBeUndefined();
    },
  );

  /*
   * `choose` is the page's spelling of `options`, and the one place the two
   * could disagree without anything running: a row whose page ran YAML to YAML
   * while its unit case ran YAML to JSON would be two rows under one number.
   */
  it.each(runnable)(
    'row $row, $id: chooses on the page exactly the options it runs with',
    async (entry) => {
      const tool = await loadTool(entry.tool as ToolId);
      const defaults = tool.defaultOptions as Record<string, unknown>;
      const chosen: Record<string, unknown> = {};
      for (const [label, choice] of Object.entries(entry.drawn.choose)) {
        const field = tool.optionFields.find((candidate) => candidate.label === label);
        expect(
          field?.control,
          `${label} is not a select on ${entry.tool}: checkLossCorpus can only choose from a listbox, so a typed option belongs in the row's input`,
        ).toBe('select');
        if (field?.control !== 'select') continue;
        const value = field.choices.find((option) => option.label === choice)?.value;
        expect(value, `${label} offers no ${choice}`).toBeDefined();
        chosen[field.key] = value;
      }
      // A default chosen out loud is harmless; a value that is not the row's, or
      // an option the row sets and the page never touches, is two rows.
      for (const [key, value] of Object.entries(chosen)) {
        expect(value, key).toBe(key in entry.options ? entry.options[key] : defaults[key]);
      }
      const differ = Object.keys(entry.options).filter(
        (key) => defaults[key] !== entry.options[key],
      );
      expect(differ.filter((key) => !(key in chosen))).toEqual([]);
    },
  );

  it.each(runnable)(
    'row $row, $id: its note carries every word the harness looks for',
    async (entry) => {
      const outputs = await run(entry, entry.input ?? '');
      const notes = warnNotes(entry.tool, outputs);
      const note = matchingNote(notes, entry.expect);
      expect(note, 'the row is not told, so there is nothing to look for').not.toBeNull();
      const whole = note === null ? '' : `${note.title} ${note.body}`;
      for (const part of entry.drawn.says ?? []) expect(whole).toContain(part);
      const face = entry.drawn.face ?? entry.expect.titleContains;
      expect(
        contains(note?.title ?? '', face),
        `the face prints the title, and it lacks ${face}`,
      ).toBe(true);

      const everything = notes.map((each) => `${each.title} ${each.body}`).join(' | ');
      for (const part of entry.drawn.unsaid ?? []) expect(everything).not.toContain(part);
      const answer = answerOf(entry, outputs);
      for (const part of entry.drawn.outputLacks ?? []) expect(answer).not.toContain(part);
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
