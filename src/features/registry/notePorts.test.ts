import { describe, expect, it } from 'vitest';

import { lossNotesOf, type LossNote } from '@/features/canvas/resultSummary';
import { type ToolInputs, type ToolOutputs, type ToolRunContext } from '@/features/registry/types';
import { residentBinary } from '@/lib/binary';

import { loadTool } from './loader';
import { getManifestEntry, TOOL_MANIFEST, type ToolId, type ToolManifestEntry } from './manifest';
import corpus from './spec/loss-corpus.json';
import harness from '../../../scripts/cross-browser-check.mjs?raw';
import harnessClips from '../../tools/video-remux/spec/located.json';

/**
 * THE POSITIVE PARTNER FOR `ToolNote.reaches`.
 *
 * A `warn` note now says which of its tool's output ports the loss is in, and
 * the canvas follows only those wires - see `lossTrace.ts`. Every failure mode
 * of that field is SILENT:
 *
 *   - a port id with a typo matches no wire, so the loss stops at the node that
 *     reported it and the canvas is exactly as quiet as it was before;
 *   - an empty list does the same;
 *   - a port that no longer exists does the same;
 *   - and a tool that grows a second data port without revisiting its notes
 *     under-reports on the new one, which nothing anywhere would notice.
 *
 * None of those throws, none fails a type check, and every one of them looks
 * like "this conversion happened not to lose anything". So the claim is
 * asserted against the manifest rather than left to the call sites.
 *
 * TWO HALVES, because one tool cannot run here at all. `image-convert` needs
 * a canvas, and jsdom has none - so it is held to the assumption its mapping
 * is built on instead: exactly one non-report output port, called `output`.
 * That is the thing that would stop being true if somebody gave it a second
 * data port, which is the case the hard-coded `['output']` in its index.ts
 * would get wrong. (`video-remux` was held the same way, on the grounds that
 * it "needs a real container" jsdom lacks; it does not - `makeMp4` builds one,
 * and `determinism.test.ts` has run the tool here since round twenty-five. So
 * since round twenty-seven its loss is in the list below and its `reaches` is
 * checked for real.)
 */

/** Unpadded base64url, for the hand-built token below. */
function base64url(text: string): string {
  return btoa(text).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

const context: ToolRunContext = {
  signal: new AbortController().signal,
};

/** Ports a loss could legitimately be in: everything but the report itself. */
function dataPortIds(toolId: ToolId): readonly string[] {
  return getManifestEntry(toolId)
    .outputs.filter((port) => port.presentation !== 'report')
    .map((port) => port.id);
}

/**
 * Every warn note in a result, read by the canvas's own reader - which is what
 * `reaches` is FOR. A second walk here had drifted from it.
 */
function warnNotes(toolId: ToolId, outputs: ToolOutputs): readonly LossNote[] {
  return lossNotesOf(getManifestEntry(toolId), outputs);
}

async function run(
  toolId: ToolId,
  inputs: ToolInputs,
  options: Record<string, unknown> = {},
): Promise<ToolOutputs> {
  const tool = await loadTool(toolId);
  const result = await tool.run({
    inputs,
    options: { ...(tool.defaultOptions as Record<string, unknown>), ...options },
    context,
  });
  if (!result.ok) throw new Error(`${toolId} failed: ${result.error.message}`);
  return result.value;
}

/**
 * One input per runnable reporting tool that really does lose something.
 *
 * Each is a case the conversion matrix already documents, so this list is not a
 * second opinion about what is lossy - it is the same losses, asked a different
 * question.
 */
const LOSSY_RUNS: readonly {
  readonly toolId: ToolId;
  readonly what: string;
  readonly inputs: ToolInputs;
  readonly options?: Record<string, unknown>;
}[] = [
  {
    toolId: 'structured-data',
    what: 'a nested object flattened into a CSV cell',
    inputs: { input: { type: 'text', text: '[{"user": {"name": "ada"}, "id": 1}]' } },
    options: { source: 'auto', target: 'csv' },
  },
  {
    toolId: 'structured-data',
    what: 'an integer past 2^53, which the parser rounds',
    inputs: { input: { type: 'text', text: '{"id": 12345678901234567890}' } },
    options: { source: 'auto', target: 'json' },
  },
  {
    toolId: 'structured-data',
    what: 'a YAML stream flattened into an array',
    inputs: { input: { type: 'text', text: 'a: 1\n---\nb: 2\n' } },
    options: { source: 'auto', target: 'json' },
  },
  {
    /*
     * Round eleven's note, added the day it landed. The list is the nearest
     * thing in this repository to an enforcement of `lossy, told`, and a loss
     * that is not in it is one nothing holds to naming a port it can travel
     * to - which is how `color-convert` escaped for five rounds.
     */
    toolId: 'structured-data',
    what: 'a YAML key that was not text, which the value model made text',
    inputs: { input: { type: 'text', text: '2024: launched\n' } },
    options: { source: 'yaml', target: 'yaml' },
  },
  {
    /*
     * Round twelve's three, added the day they landed, for the reason the
     * entry above gives.
     *
     * The first is deliberately the RICH document rather than one loss at a
     * time: four kinds of presentation in one file is what a real manifest
     * looks like, and it is the case that decides whether the census note
     * still names a port when every branch of it fires at once.
     */
    toolId: 'structured-data',
    what: 'a YAML comment, anchor, tag and block style, none of which the model holds',
    inputs: {
      input: {
        type: 'text',
        text: '# why\ndefaults: &d\n  a: 1\nuse: *d\ntagged: !mine 1\ntext: |\n  one\n  two\n',
      },
    },
    options: { source: 'yaml', target: 'json' },
  },
  {
    toolId: 'structured-data',
    what: 'a CSV header cell whose spaces were removed',
    inputs: { input: { type: 'text', text: 'alpha, shipped at \n1,2\n' } },
    options: { source: 'csv', target: 'json' },
  },
  {
    toolId: 'structured-data',
    what: 'a duplicate JSON key, where the last one wins',
    inputs: { input: { type: 'text', text: '{"retries": 3, "retries": 5}' } },
    options: { source: 'json', target: 'json' },
  },
  {
    /*
     * Built by hand rather than by `JSON.stringify`, because stringifying a
     * number past 2^53 writes the ROUNDED digits and there is nothing left to
     * find. The signature is nonsense on purpose: decoding does not verify.
     */
    toolId: 'jwt-decode',
    what: 'a claim past 2^53, which the decoder rounds',
    inputs: {
      input: {
        type: 'text',
        text: `${base64url('{"alg":"HS256","typ":"JWT"}')}.${base64url('{"sub":12345678901234567890}')}.c2ln`,
      },
    },
  },
  {
    toolId: 'base64',
    what: 'a non-canonical final character',
    inputs: { input: { type: 'text', text: 'QR==' } },
    options: { mode: 'decode' },
  },
  {
    /*
     * THE ENTRY THIS LIST COULD NOT HOLD UNTIL ROUND NINE.
     *
     * `color-convert` is the tool the wrong matrix cell escaped through, and
     * it escaped by belonging to the one tool this list's own subject line -
     * "one input per runnable REPORTING tool" - defined away: with no report
     * port it would have failed the `notes.length > 0` guard below rather than
     * being covered by it. The port exists now, so the cell is enforceable.
     */
    toolId: 'color-convert',
    what: 'an OKLCH colour outside sRGB, clipped per channel',
    inputs: { input: { type: 'text', text: 'oklch(0.7 0.4 150)' } },
    options: { target: 'hex' },
  },
  {
    toolId: 'color-convert',
    what: 'components outside the range hsl() allows, clamped',
    inputs: { input: { type: 'text', text: 'hsl(361 110% -5%)' } },
    options: { target: 'hex' },
  },
  {
    toolId: 'text-convert',
    what: 'markup the allow-list does not permit',
    inputs: { input: { type: 'text', text: 'Text\n\n<marquee onclick="x()">hi</marquee>\n' } },
    options: { source: 'markdown', target: 'html' },
  },
  {
    // Round thirteen's, added the day they landed, for the reason round
    // eleven's entry above gives. A write-half note, so `data` must escape it.
    toolId: 'structured-data',
    what: 'a TSV cell holding a tab, which TSV has no spelling for',
    inputs: { input: { type: 'text', text: '[{"note": "has\\ttab"}]' } },
    options: { source: 'json', target: 'tsv' },
  },
  {
    toolId: 'structured-data',
    what: 'a YAML flow collection written back as a block',
    inputs: { input: { type: 'text', text: 'a: {b: 1}\n' } },
    options: { source: 'yaml', target: 'yaml' },
  },
  {
    toolId: 'text-convert',
    what: 'a class name the sanitiser takes out of a class it keeps',
    inputs: {
      input: { type: 'text', text: '<p><a class="btn" href="https://example.com">x</a></p>' },
    },
    options: { source: 'html', target: 'html-sanitised' },
  },
  {
    toolId: 'text-convert',
    what: 'an attribute the sanitiser removes',
    inputs: { input: { type: 'text', text: '<p class="lead" data-x="1">Hello</p>' } },
    options: { source: 'html', target: 'html-sanitised' },
  },
  {
    /*
     * The Markdown target, whose census is new in round ten. Listed because
     * this is where `reaches` is easiest to get wrong: for every other target
     * `rendered` is the sanitised hub and still HAS what the round trip
     * dropped, and for this one `rendered` is the output re-rendered and lost
     * exactly what the output lost.
     */
    toolId: 'text-convert',
    what: 'a table caption Markdown has nowhere to put',
    inputs: {
      input: {
        type: 'text',
        text: '<table><caption>Quarterly sales</caption><tr><th>Region</th></tr><tr><td>North</td></tr></table>',
      },
    },
    options: { source: 'html', target: 'markdown' },
  },
  {
    /*
     * `timestamp`'s, added the day it landed. Each loses something in a
     * different half: the unit guess and the leap second are in the READ half
     * and reach every notation; the dropped precision is in the WRITE half,
     * and `all` - which carries every unit exactly - must escape it.
     */
    toolId: 'timestamp',
    what: 'a number whose size-read unit puts it in 1970',
    inputs: { input: { type: 'text', text: '86400' } },
  },
  {
    toolId: 'timestamp',
    what: 'milliseconds written as whole seconds',
    inputs: { input: { type: 'text', text: '1727308800123' } },
    options: { target: 's' },
  },
  {
    toolId: 'timestamp',
    what: 'a leap second, which Unix time has no number for',
    inputs: { input: { type: 'text', text: '2016-12-31T23:59:60Z' } },
  },
  {
    // The clip check:browsers repackages, held to `makeMp4` by its own test.
    toolId: 'video-remux',
    what: 'a recording location, which a repackage leaves behind',
    inputs: {
      input: {
        type: 'bytes',
        data: residentBinary(Uint8Array.from(atob(harnessClips.located), (c) => c.charCodeAt(0))),
        mediaType: null,
        filename: 'walk.mp4',
      },
    },
  },
];

describe('every warn note names the ports its loss is actually in', () => {
  it.each(LOSSY_RUNS)('$toolId: $what', async ({ toolId, inputs, options }) => {
    const outputs = await run(toolId, inputs, options);
    const notes = warnNotes(toolId, outputs);
    const ports = dataPortIds(toolId);

    /*
     * The run has to LOSE something, or the rest of this test asserts nothing
     * about an empty list. Round six's lesson, applied here: a check whose
     * subject is missing passes just as happily as one whose subject is right.
     */
    expect(notes.length, 'this input was chosen because it loses something').toBeGreaterThan(0);

    for (const note of notes) {
      expect(note.reaches, `"${note.title}" names no port, so it cannot travel`).not.toEqual([]);
      for (const portId of note.reaches) {
        expect(ports, `"${note.title}" names a port ${toolId} does not declare`).toContain(portId);
      }
    }
  });

  /*
   * And the tools whose losses jsdom cannot produce. Both map every warn note
   * to `['output']` in their index.ts, which is correct exactly while that is
   * the only port a loss could be in.
   */
  it.each(['image-convert'] as const)(
    '%s has the one data port its hard-coded `reaches` assumes',
    (toolId) => {
      expect(dataPortIds(toolId)).toEqual(['output']);
    },
  );

  /*
   * A tool with a `report` port and no warn note anywhere is fine. A tool with
   * a `report` port that is NOT in the list above is a tool whose notes nothing
   * here has looked at, and this is the line that falls due when one is added.
   */
  it('has a lossy run listed for every tool that can report one', () => {
    /*
     * Read through the DECLARED type rather than off the const literal: the
     * literal's inferred type has no `presentation` key on the ports that lack
     * one, so the filter would not compile - and widening it here is the same
     * move `registry.test.ts` makes, for the same reason. It keeps the check a
     * guard that survives the manifest changing rather than compile-time noise.
     */
    const entries: readonly ToolManifestEntry[] = TOOL_MANIFEST;
    const reporting = entries
      .filter((entry) => entry.outputs.some((port) => port.presentation === 'report'))
      .map((entry) => entry.id);

    const covered = new Set([
      ...LOSSY_RUNS.map((entry) => entry.toolId),
      // Held to its port shape above instead; jsdom cannot run it.
      'image-convert',
    ]);

    expect(reporting.filter((id) => !covered.has(id))).toEqual([]);
  });

  /*
   * AND EVERY ONE OF THEM HAS ITS LOSS DRAWN IN A REAL ENGINE. What this file
   * holds is the payload; "told" also means a person is shown it - on the
   * tool page, and on a node's face - which only check:browsers can see. A
   * tool gets there by corpus rows (`checkLossCorpus`) or, where a row cannot
   * be written for it, by an entry in `BEYOND_THE_CORPUS`
   * (`checkLossesBeyondTheCorpus`). Until round twenty-seven base64,
   * jwt-decode, image-convert and video-remux had neither, and nothing said so.
   */
  it('has the losses of every tool that can report one drawn in a real engine', () => {
    const entries: readonly ToolManifestEntry[] = TOOL_MANIFEST;
    const reporting = entries
      .filter((entry) => entry.outputs.some((port) => port.presentation === 'report'))
      .map((entry) => entry.id);

    const start = harness.indexOf('const BEYOND_THE_CORPUS = [');
    expect(start, 'no BEYOND_THE_CORPUS in scripts/cross-browser-check.mjs').toBeGreaterThan(-1);
    const list = harness.slice(start, harness.indexOf('\n];', start));
    const beyond = [...list.matchAll(/^ {4}tool: '([\w-]+)',$/gm)].map((match) => match[1]);
    expect(beyond.length, 'the list was read').toBeGreaterThan(0);

    const sections = harness.slice(harness.indexOf('const SECTIONS = ['));
    expect(sections.slice(0, sections.indexOf('];'))).toContain('checkLossesBeyondTheCorpus,');

    const drawn = new Set([...corpus.cases.map((entry) => entry.tool), ...beyond]);
    expect(reporting.filter((id) => !drawn.has(id))).toEqual([]);
  });
});
