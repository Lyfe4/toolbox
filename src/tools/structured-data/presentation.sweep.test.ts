import { describe, expect, it } from 'vitest';
import { isAlias, isScalar, parseAllDocuments, visit } from 'yaml';

import {
  isJsonArray,
  isJsonObject,
  type JsonValue,
  type ToolRunContext,
} from '@/features/registry/types';

import structuredDataTool from './index';
import suite from './spec/yaml-test-suite.json';

/**
 * DOES THE PRESENTATION NOTE CRY WOLF? ASKED OF 284 DOCUMENTS RATHER THAN OF
 * THE FOUR IN THE LOSS CORPUS.
 *
 * `lib/notes.ts` makes `warn` a promise - "something went in and did not come
 * out" - and round twelve's note is the first one in this tool that fires on
 * ordinary, correct YAML. Comments are in nearly every real config file, so a
 * note about them is either the most useful one here or the one that teaches
 * people to stop reading notes, and which of the two it is cannot be settled
 * by the corpus: four documents chosen to lose something prove a note fires,
 * not that it fires only when it should.
 *
 * THE INSTRUMENT IS THE OUTPUT, NOT A SECOND OPINION ABOUT THE INPUT. A note
 * that says a comment was not carried over is TRUE exactly when the source has
 * a comment and the output does not, so both halves are measured, from two
 * different documents, with the same reader. That is what makes this more than
 * a restatement of the code: the note is built while READING, and it is judged
 * here against something that did not exist when it was built.
 *
 * Both directions are asserted, and they are different claims:
 *
 *   said-and-false   the note named something the output still has. Crying
 *                    wolf, and the reason this file exists.
 *   silent-but-lost  the output lost something and no note said so. A silent
 *                    loss, which is the thing round twelve is closing.
 *
 * Both are zero over the suite on both targets, and the numbers behind that -
 * 44 comments, 30 anchors, 34 tags, 59 block styles - are in
 * docs/test-findings.md. Two earlier versions of `styleIsLost` failed this:
 * one missed eight documents whose literal block came back plain, and the
 * version that fixed those reported three that had not lost anything.
 */

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

interface SuiteCase {
  readonly id: string;
  readonly yaml: string;
}

const CASES = (suite as unknown as { readonly cases: readonly SuiteCase[] }).cases;

interface Holds {
  readonly comment: boolean;
  readonly anchor: boolean;
  readonly tag: boolean;
  /** Counted rather than flagged: see the note in `lostBetween`. */
  readonly folded: number;
  readonly literal: number;
}

const NOTHING: Holds = { comment: false, anchor: false, tag: false, folded: 0, literal: 0 };

/** What a YAML document actually holds, asked of its text. */
function holds(text: string): Holds {
  const found = { comment: false, anchor: false, tag: false, folded: 0, literal: 0 };

  let documents;
  try {
    documents = parseAllDocuments(text, { logLevel: 'error' });
  } catch {
    return NOTHING;
  }

  for (const document of documents) {
    if (document.errors.length > 0) continue;
    if (document.commentBefore !== null || document.comment !== null) found.comment = true;

    visit(document, {
      Node: (_index, node) => {
        if (node.commentBefore != null || node.comment != null) found.comment = true;
        if (isAlias(node)) {
          found.anchor = true;
          return undefined;
        }
        if (typeof node.anchor === 'string' && node.anchor !== '') found.anchor = true;
        if (typeof node.tag === 'string' && node.tag !== '') found.tag = true;
        if (isScalar(node) && node.type === 'BLOCK_FOLDED') found.folded += 1;
        if (isScalar(node) && node.type === 'BLOCK_LITERAL') found.literal += 1;
        return undefined;
      },
    });
  }

  return found;
}

/**
 * COUNTED RATHER THAN FLAGGED, and the difference decided three verdicts.
 *
 * `strip: |-` beside `clip: |` is one document with two literal blocks, and
 * only the first loses its style - the stripped one reads to a value with no
 * line break in it and comes back plain. "Does the output still have a literal
 * somewhere" answers yes and calls the note a false positive; "does it have
 * FEWER than it started with" answers the question that was asked.
 */
function lostBetween(source: Holds, output: Holds): Readonly<Record<string, boolean>> {
  return {
    comment: source.comment && !output.comment,
    anchor: source.anchor && !output.anchor,
    tag: source.tag && !output.tag,
    style: source.folded > output.folded || source.literal > output.literal,
  };
}

const KINDS = ['comment', 'anchor', 'tag', 'style'] as const;

async function convert(
  text: string,
  target: 'json' | 'yaml',
): Promise<{ readonly output: string; readonly note: string | null } | null> {
  const result = await structuredDataTool.run({
    inputs: { input: { type: 'text', text } },
    options: {
      ...(structuredDataTool.defaultOptions as Record<string, unknown>),
      source: 'yaml',
      target,
    },
    context,
  });
  if (!result.ok) return null;

  const report = result.value.report;
  const data: JsonValue = report?.type === 'json' && isJsonObject(report.data) ? report.data : {};
  const raw: JsonValue | undefined = isJsonObject(data) ? data.notes : undefined;
  const notes = raw !== undefined && isJsonArray(raw) ? raw.filter(isJsonObject) : [];
  const output = result.value.output;

  return {
    output: output?.type === 'text' ? output.text : '',
    note:
      notes
        .filter((note) => note.level === 'warn')
        .map((note) => (typeof note.title === 'string' ? note.title : ''))
        .find((title) => title.startsWith('Not carried over')) ?? null,
  };
}

describe.each(['json', 'yaml'] as const)(
  'the presentation note over the yaml-test-suite, target %s',
  (target) => {
    it('never names something the output still has, and never stays silent about one it lost', async () => {
      const wolf: string[] = [];
      const silent: string[] = [];
      const tally: Record<string, number> = { comment: 0, anchor: 0, tag: 0, style: 0 };
      let readable = 0;

      for (const entry of CASES) {
        const result = await convert(entry.yaml, target);
        if (result === null) continue;
        readable += 1;

        /*
         * A JSON target holds NONE of it by construction - no comments, no
         * anchors, no tags, no scalar styles - so the output is not parsed as
         * YAML for one. Parsing JSON text with a YAML reader would find `#`
         * inside a string and call it a comment.
         */
        const output = target === 'yaml' ? holds(result.output) : NOTHING;
        const lost = lostBetween(holds(entry.yaml), output);
        const note = result.note ?? '';

        for (const kind of KINDS) {
          const said = note.includes(kind);
          if (said && lost[kind] === true) tally[kind] = (tally[kind] ?? 0) + 1;
          else if (said) wolf.push(`${entry.id}: said ${kind}, output still has it`);
          else if (lost[kind] === true) silent.push(`${entry.id}: lost ${kind}, said nothing`);
        }
      }

      /*
       * The suite has to be here and readable, or the two empty arrays below
       * are a check whose subject is missing - which is the failure this
       * repository has now found four times.
       */
      expect(readable).toBeGreaterThan(250);
      for (const kind of KINDS) {
        expect(tally[kind], `the note never names a ${kind} in the whole suite`).toBeGreaterThan(
          20,
        );
      }

      expect(wolf, 'the note named something the output still has').toEqual([]);
      expect(silent, 'the output lost something and no note said so').toEqual([]);
    }, 120_000);
  },
);
