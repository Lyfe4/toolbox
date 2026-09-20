import { describe, expect, it } from 'vitest';

import {
  isJsonArray,
  isJsonObject,
  type JsonValue,
  type ToolInputs,
  type ToolOutputs,
  type ToolRunContext,
} from '@/features/registry/types';

import { loadTool } from './loader';
import { getManifestEntry, TOOL_MANIFEST, type ToolId, type ToolManifestEntry } from './manifest';

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
 * TWO HALVES, because two tools cannot run here at all. `image-convert` needs
 * an `OffscreenCanvas` and `video-remux` needs a real container, and jsdom has
 * neither - so those two are held to the assumption their mapping is built on
 * instead: exactly one non-report output port, called `output`. That is the
 * thing that would stop being true if somebody gave either a second data port,
 * which is the case the hard-coded `['output']` in their index.ts would get
 * wrong.
 */

/** Unpadded base64url, for the hand-built token below. */
function base64url(text: string): string {
  return btoa(text).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

/** Ports a loss could legitimately be in: everything but the report itself. */
function dataPortIds(toolId: ToolId): readonly string[] {
  return getManifestEntry(toolId)
    .outputs.filter((port) => port.presentation !== 'report')
    .map((port) => port.id);
}

interface ReadNote {
  readonly title: string;
  readonly reaches: readonly string[];
}

/** Every warn note in a result, read the way the canvas reads one. */
function warnNotes(toolId: ToolId, outputs: ToolOutputs): readonly ReadNote[] {
  const found: ReadNote[] = [];

  for (const port of getManifestEntry(toolId).outputs) {
    if (port.presentation !== 'report') continue;
    const value = outputs[port.id];
    if (value?.type !== 'json' || !isJsonObject(value.data)) continue;
    const notes: JsonValue | undefined = value.data.notes;
    if (notes === undefined || !isJsonArray(notes)) continue;

    for (const note of notes) {
      if (!isJsonObject(note) || note.level !== 'warn') continue;
      const reaches: JsonValue | undefined = note.reaches;
      found.push({
        title: typeof note.title === 'string' ? note.title : '',
        reaches:
          reaches !== undefined && isJsonArray(reaches)
            ? reaches.filter((id): id is string => typeof id === 'string')
            : [],
      });
    }
  }

  return found;
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
  it.each(['image-convert', 'video-remux'] as const)(
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
      // Held to their port shape above instead; jsdom can run neither.
      'image-convert',
      'video-remux',
    ]);

    expect(reporting.filter((id) => !covered.has(id))).toEqual([]);
  });
});
