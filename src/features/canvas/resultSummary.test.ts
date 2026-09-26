import { describe, expect, it } from 'vitest';

import { getManifestEntry, TOOL_MANIFEST } from '@/features/registry';
import type { ToolManifestEntry } from '@/features/registry';
import type { ToolValue } from '@/features/registry/types';
import { bytesValue } from '@/features/registry/types';

import { lossSummary, summariseOutputs, summariseValue, SUMMARY_LIMIT } from './resultSummary';

/**
 * WHAT A NODE SAYS ABOUT ITS RESULT.
 *
 * A node is 224px wide with two clamped lines, so every one of these is a
 * MEASUREMENT of the result rather than a slice of it. The cases below are the
 * ones where measuring the wrong thing produces a plausible sentence that is
 * false, which is the failure worth a test - a summary nobody can tell is
 * wrong is worse than no summary.
 */

function text(value: string): ToolValue {
  return { type: 'text', text: value };
}

function json(data: unknown): ToolValue {
  return { type: 'json', data: data as never };
}

function bytes(source: readonly number[]): ToolValue {
  return bytesValue(new Uint8Array(source));
}

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('regex', () => {
  it('counts matches', () => {
    expect(summariseValue(json({ count: 47 }), 'regex')).toBe('47 matches');
  });

  it('says no matches rather than zero of them', () => {
    // "0 matches" is arithmetic; "No matches" is the answer to the question
    // the person asked, and it is the outcome they most need to notice.
    expect(summariseValue(json({ count: 0 }), 'regex')).toBe('No matches');
  });

  it('singularises', () => {
    expect(summariseValue(json({ count: 1 }), 'regex')).toBe('1 match');
  });

  /*
   * THE COUNT OUTLIVES THE LISTING, and this is the whole reason the summary
   * reads `count` and not `listed`. The regex tool caps how many matches it
   * enumerates; a node summarising the enumeration would report "200 matches"
   * for a pattern that found five thousand - a confident, plausible, wrong
   * number, which the README records this tool producing once already.
   */
  it('reports the real count even when the listing was truncated', () => {
    expect(summariseValue(json({ count: 5000, listed: 200 }), 'regex')).toBe('5000 matches');
  });

  /*
   * A TRUNCATED LISTING AND A STOPPED SCAN ARE DIFFERENT CLAIMS, and only one
   * of them leaves `count` exact. `truncated` means the tool enumerated fewer
   * matches than it found and still counted them all; `complete: false` means
   * the two-second budget cut the scan off, so `count` is a floor. The listing
   * on the text port says "there may be more" in its last line, and this is
   * the node's room for the same doubt.
   */
  it('marks a count the scan did not finish reaching', () => {
    expect(summariseValue(json({ count: 5000, listed: 200, complete: false }), 'regex')).toBe(
      '5000+ matches',
    );
  });

  it('leaves the count alone when the scan ran to the end', () => {
    // The negative control. A `+` on every count is a `+` that means nothing,
    // and `complete` is absent from a payload written before it existed.
    expect(summariseValue(json({ count: 47, complete: true }), 'regex')).toBe('47 matches');
    expect(summariseValue(json({ count: 47 }), 'regex')).toBe('47 matches');
  });

  /*
   * REPLACING IS NOT SEARCHING, and the node is the one place the difference
   * is invisible. A pattern that matched nothing hands the subject back
   * unchanged, so `output` holds the text that went in and its first line read
   * as an ordinary result - a replacement that did nothing and one that worked
   * were the same node. `count` is what tells them apart, and it is the same
   * number either way: the scan enumerates every match for a global pattern
   * and exactly one for a non-global one, which is what `String#replace` does
   * with the same regex.
   */
  it('counts replacements rather than matches when it was replacing', () => {
    expect(summariseValue(json({ count: 3, mode: 'replace' }), 'regex')).toBe('3 replaced');
    expect(summariseValue(json({ count: 1, mode: 'replace' }), 'regex')).toBe('1 replaced');
  });

  it('says nothing was replaced rather than that nothing matched', () => {
    expect(summariseValue(json({ count: 0, mode: 'replace' }), 'regex')).toBe('Nothing replaced');
  });

  it('still talks about matches in match mode', () => {
    // The control for the pair above: `mode` is read, not assumed, and a
    // payload that does not carry it is a search.
    expect(summariseValue(json({ count: 3, mode: 'match' }), 'regex')).toBe('3 matches');
    expect(summariseValue(json({ count: 0, mode: 'match' }), 'regex')).toBe('No matches');
  });
});

describe('diff', () => {
  it('gives additions and removals', () => {
    expect(
      summariseValue(json({ identical: false, stats: { added: 12, removed: 3 } }), 'diff'),
    ).toBe('+12 −3');
  });

  /*
   * Not "+0 −0". Two documents that differ only in the ways the options were
   * told to ignore is a real outcome and the reason those options exist; a
   * pair of zeroes reads as the tool having failed to run.
   */
  it('names an identical comparison rather than reporting two zeroes', () => {
    expect(summariseValue(json({ identical: true, stats: { added: 0, removed: 0 } }), 'diff')).toBe(
      'Identical',
    );
  });

  /*
   * THE ONE SUMMARY IN THE SET THAT ASSERTS SAMENESS.
   *
   * A byte order mark is removed when bytes are decoded at a document port, so
   * a file that had one and a file that did not compare equal - and the node
   * then says `Identical` about two files that are not. The panel says why; the
   * node is where a chain gets read.
   */
  it('stops claiming Identical when only a byte order mark differed', () => {
    expect(
      summariseValue(
        json({
          identical: true,
          stats: { added: 0, removed: 0 },
          notes: { byteOrderMark: { original: true, changed: false } },
        }),
        'diff',
      ),
    ).toBe('Identical · BOM differs');
  });

  it('still says Identical when both sides have one, or neither does', () => {
    // The negative control, both ways round: a mark on both sides is not a
    // difference, and a summary that said so would fire on every pair of files
    // an editor has touched.
    for (const both of [true, false]) {
      expect(
        summariseValue(
          json({
            identical: true,
            stats: { added: 0, removed: 0 },
            notes: { byteOrderMark: { original: both, changed: both } },
          }),
          'diff',
        ),
      ).toBe('Identical');
    }
  });
});

describe('jwt', () => {
  /*
   * THE ONE SUMMARY THAT IS A WARNING RATHER THAN A MEASUREMENT.
   *
   * A JWT payload is base64, not encryption. A node in the middle of a chain
   * is exactly where nobody opens the panel, so a decoded token that reads as
   * ordinary at a glance is one that makes a forgery look authoritative. The
   * verdict comes first and it shouts, in the same words JwtView uses.
   */
  it('leads with the verdict when nothing checked the signature', () => {
    expect(
      summariseValue(json({ signature: { algorithm: 'HS256', verified: false } }), 'jwt'),
    ).toBe('NOT VERIFIED · HS256');
  });

  it('leads with the verdict when something did', () => {
    expect(summariseValue(json({ signature: { algorithm: 'HS256', verified: true } }), 'jwt')).toBe(
      'Verified · HS256',
    );
  });

  it('never reports a verified token for a payload it cannot read', () => {
    // A malformed payload falls through to the JSON shape rather than
    // defaulting to anything about trust.
    expect(summariseValue(json({ signature: 'yes' }), 'jwt')).toBe('1 key');
  });
});

describe('report', () => {
  it('uses the report’s own sentence rather than deriving a second one', () => {
    expect(summariseValue(json({ summary: '1.0 kB → 800 B (-20.0%)' }), 'report')).toBe(
      '1.0 kB → 800 B (-20.0%)',
    );
  });

  it('falls back to the shape when there is no summary line', () => {
    expect(summariseValue(json({ from: {}, to: {} }), 'report')).toBe('2 keys');
  });
});

describe('text', () => {
  it('is the first line', () => {
    expect(summariseValue(text('hello world\nsecond line'))).toBe('hello world');
  });

  it('skips leading blank lines rather than calling the result empty', () => {
    expect(summariseValue(text('\n\n  actual content'))).toBe('actual content');
  });

  /*
   * An empty result rendered as an empty summary is indistinguishable from no
   * summary at all - the node would look as though it had not run. It is also
   * usually the surprise: an encoder that produced nothing is the thing you
   * want to see from across the canvas.
   */
  it('says so when a run produced nothing', () => {
    expect(summariseValue(text(''))).toBe('Empty');
    expect(summariseValue(text('   \n \t '))).toBe('Whitespace only');
  });

  it('truncates, so a 30 MB document never reaches a node’s accessible name', () => {
    const summary = summariseValue(text('x'.repeat(10_000)));
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('bytes', () => {
  /*
   * The SNIFFED label, never the declared one - the same rule the rest of the
   * app follows. `payload.zip` renamed to `photo.png` describes itself here as
   * whatever its bytes actually are.
   */
  it('is the size and the sniffed kind', () => {
    expect(summariseValue(bytes([...PNG_HEADER, ...new Array<number>(2048).fill(0)]))).toMatch(
      /^2\.0 kB PNG image$/,
    );
  });

  it('describes bytes that are not a known format by what they look like', () => {
    expect(summariseValue(bytes([0x68, 0x69]))).toBe('2 B Text');
  });
});

describe('the remaining data types', () => {
  it('gives a colour as hex', () => {
    expect(summariseValue({ type: 'color', color: { r: 0.2, g: 0.4, b: 1, a: 1 } })).toBe(
      '#3366ff',
    );
  });

  it('says when a colour is not opaque, because the hex alone would not', () => {
    expect(summariseValue({ type: 'color', color: { r: 0, g: 0, b: 0, a: 0.5 } })).toBe(
      '#000000 at 50%',
    );
  });

  it('describes a bare JSON value by its shape', () => {
    expect(summariseValue(json({ a: 1, b: 2, c: 3 }))).toBe('3 keys');
    expect(summariseValue(json([1, 2]))).toBe('2 items');
  });

  it('describes a JSON value that is not a collection at all', () => {
    /*
     * A `json` port can carry a scalar - `structured-data` reading `42` is one -
     * and the branch for it sits below the two above, where breaking it turns
     * every scalar into the word "null" and neither of those assertions moves.
     */
    expect(summariseValue(json('ada'))).toBe('ada');
    expect(summariseValue(json(42))).toBe('42');
    expect(summariseValue(json(false))).toBe('false');
    expect(summariseValue(json(null))).toBe('null');
  });
});

/* -------------------------------------------------------------------------- *
 * The ceiling on the sentence
 * -------------------------------------------------------------------------- */

describe('the sixty characters a summary is allowed', () => {
  /*
   * THE LIMIT IS ALSO THE ACCESSIBLE NAME, which is why it exists at all: a
   * 30 MB decoded document in a node's name is a string an assistive technology
   * reads from end to end. The number and the comparison at the boundary were
   * both unasserted - `60` could become anything and `<=` could become `<` with
   * nothing to notice - and a cap nobody has counted is a cap that drifts.
   */
  it('keeps a line exactly at the limit whole', () => {
    const exact = 'x'.repeat(SUMMARY_LIMIT);
    expect(summariseValue(text(exact))).toBe(exact);
    expect(summariseValue(text(exact))).toHaveLength(SUMMARY_LIMIT);
  });

  it('clips one character past it, and the ellipsis is inside the budget', () => {
    const over = 'x'.repeat(SUMMARY_LIMIT + 1);
    const summary = summariseValue(text(over));

    expect(summary).toHaveLength(SUMMARY_LIMIT);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary).toBe(`${'x'.repeat(SUMMARY_LIMIT - 1)}…`);
  });

  it('is sixty, which is the number the README and the node both state', () => {
    expect(SUMMARY_LIMIT).toBe(60);
  });
});

describe('which output a node summarises', () => {
  /*
   * THE FIRST DECLARED OUTPUT, and only that one. Ten of the eleven tools have
   * more than one, and the manifest's order is not arbitrary: the first port
   * is the tool's answer and the rest are its working. This asserts the
   * ordering rule through one tool; the rule for every tool, including one
   * added later, is `ports.test.ts`'s "%s calls its first output `output`" -
   * which this comment used to claim for itself.
   */
  it('summarises the first declared output', () => {
    /*
     * `text-convert`, because it has four outputs, the first of them carries
     * prose, and none of them measures another - so this asserts the ordering
     * rule on its own rather than through the serialisation rule below.
     */
    const entry = getManifestEntry('text-convert');
    expect(entry.outputs[0]?.id).toBe('output');
    expect(entry.outputs[0]?.measuredBy).toBeUndefined();
    expect(
      summariseOutputs(entry, {
        output: text('result line'),
        rendered: text('<p>result line</p>'),
        detected: text('markdown (confident)'),
        report: json({ summary: 'Markdown from html' }),
      }),
    ).toBe('result line');
  });

  it('is null for a node that has not produced anything', () => {
    expect(summariseOutputs(getManifestEntry('hash'), null)).toBeNull();
    expect(summariseOutputs(getManifestEntry('hash'), {})).toBeNull();
  });

  it('stays inside the limit for every tool in the manifest', () => {
    for (const entry of TOOL_MANIFEST) {
      // Every tool declares at least one output; a tool that did not would
      // have no result to summarise, and this asserts the assumption rather
      // than skipping past it.
      const port = entry.outputs[0];
      expect(port, entry.id).toBeDefined();
      const summary = summariseOutputs(entry, { [port.id]: text('a'.repeat(5_000)) });
      expect(summary, entry.id).not.toBeNull();
      expect(summary?.length, entry.id).toBeLessThanOrEqual(SUMMARY_LIMIT);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * A first output that is a serialisation
 * -------------------------------------------------------------------------- */

/**
 * WHEN THE FIRST LINE IS SYNTAX RATHER THAN AN ANSWER.
 *
 * `text` is the data type of a string, not a promise that a person wrote it,
 * and the "first non-empty line" rule was written for prose and inherited by
 * three ports that carry a serialised document. Each of them summarised as the
 * SAME STRING for every document of its kind:
 *
 *   - pretty-printed JSON as `[` or `{`, and a YAML stream as `---`;
 *   - every unified patch in the product as `--- original`, and an identical
 *     pair - which produces an empty patch - as `Empty`;
 *   - a replacement that matched nothing as the subject handed straight back,
 *     which is indistinguishable from one that worked.
 *
 * A summary that cannot tell two different results apart is carrying no
 * information about the result. So a port that serialises something names the
 * sibling holding the something, and the node prints that sibling's summary.
 *
 * EVERY ASSERTION BELOW COMES IN A PAIR: the measurement that should be drawn,
 * and the string the old rule would have drawn. The second half is what fails
 * if `measuredBy` stops being read, because the first half alone would pass
 * against a summariser that had simply learned these three sentences.
 */
/*
 * A GUESS THE ANSWER RESTS ON, which the answer gives no hint of - today only
 * a file's name deciding its format. The guess is the part the face exists to
 * carry, so it is the result that gives up room: a clip of the whole line would
 * cut the guess off first on exactly the long results where it matters.
 */
describe('a guess a report says the answer rests on', () => {
  const textConvert = getManifestEntry('text-convert');
  const long = 'word '.repeat(40);

  it('is printed whole beside a result long enough to be clipped', () => {
    const face = summariseOutputs(textConvert, {
      output: text(long),
      report: json({ summary: 'x', guess: 'CSV by its name' }),
    });
    expect(face?.endsWith(' · CSV by its name')).toBe(true);
    expect(face?.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    expect(face?.startsWith('word word')).toBe(true);
  });

  it('is not there when no report carries one, which is every report the content decided', () => {
    const face = summariseOutputs(textConvert, {
      output: text('hello'),
      report: json({ summary: 'x' }),
    });
    expect(face).toBe('hello');
  });

  it('is clipped itself when it is long, so it cannot take the whole line', () => {
    const face = summariseOutputs(textConvert, {
      output: text('hello'),
      report: json({ summary: 'x', guess: 'g'.repeat(100) }),
    });
    expect(face?.startsWith('hello · ')).toBe(true);
    expect(face?.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
  });
});

describe('a node whose answer is a serialised document', () => {
  const structured = getManifestEntry('structured-data');
  const diff = getManifestEntry('diff');
  const regex = getManifestEntry('regex-tester');

  it('measures a pretty-printed JSON document instead of quoting its bracket', () => {
    const face = summariseOutputs(structured, {
      output: text('[\n  {\n    "a": 1\n  },\n  {\n    "a": 2\n  }\n]'),
      data: json([{ a: 1 }, { a: 2 }]),
      report: json({ summary: 'JSON (detected) - JSON' }),
    });

    expect(face).toBe('2 items');
    expect(face).not.toBe('[');
  });

  it('measures an object document instead of quoting its brace', () => {
    const face = summariseOutputs(structured, {
      output: text('{\n  "a": 1,\n  "b": 2\n}'),
      data: json({ a: 1, b: 2 }),
      report: json({ summary: 'JSON (detected) - JSON' }),
    });

    expect(face).toBe('2 keys');
    expect(face).not.toBe('{');
  });

  it('measures a YAML stream instead of quoting its document marker', () => {
    const face = summariseOutputs(structured, {
      output: text('---\na: 1\n---\nb: 2\n'),
      data: json([{ a: 1 }, { b: 2 }]),
      report: json({ summary: 'YAML (detected) - YAML' }),
    });

    expect(face).toBe('2 items');
    expect(face).not.toBe('---');
  });

  /*
   * A table's header is the one of the four that is not literally constant -
   * it varies with the schema. It is constant across the DATA, though, which
   * is the question a person is asking: a filter that returned two rows and
   * one that returned five thousand were the same node.
   */
  it('measures a table by its rows rather than by its column names', () => {
    const face = summariseOutputs(structured, {
      output: text('a,b\n1,2\n3,4'),
      data: json([
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ]),
      report: json({ summary: 'JSON (detected) - CSV' }),
    });

    expect(face).toBe('2 items');
    expect(face).not.toBe('a,b');
  });

  it('measures a patch by what changed rather than by its header line', () => {
    const face = summariseOutputs(diff, {
      output: text('--- original\n+++ changed\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n'),
      changes: json({ identical: false, stats: { added: 1, removed: 1 } }),
    });

    expect(face).toBe('+1 −1');
    expect(face).not.toBe('--- original');
  });

  /*
   * And the empty patch, which is the other half of the same defect: two
   * identical documents produce no unified output at all, so the node said
   * `Empty` - the word reserved for "it ran and produced nothing", about a
   * comparison that ran and produced the most definite answer it has.
   */
  it('names an identical comparison rather than calling the empty patch empty', () => {
    const face = summariseOutputs(diff, {
      output: text(''),
      changes: json({ identical: true, stats: { added: 0, removed: 0 } }),
    });

    expect(face).toBe('Identical');
    expect(face).not.toBe('Empty');
  });

  it('counts a listing rather than quoting its first row', () => {
    const face = summariseOutputs(regex, {
      output: text('     0  alpha\n    12  amma'),
      matches: json({ count: 2, listed: 2, mode: 'match' }),
    });

    expect(face).toBe('2 matches');
    expect(face).not.toBe('0 alpha');
  });

  /*
   * THE ONE WHERE THE OLD SUMMARY WAS NOT MERELY UNINFORMATIVE BUT MISLEADING.
   * A replacement that matched nothing returns the subject unchanged, so the
   * node drew the first line of the text that went IN, under the word `ok`, and
   * the two runs below were the same node with the same face.
   */
  it('tells a replacement that did nothing from one that worked', () => {
    const subject = 'alpha beta';

    const missed = summariseOutputs(regex, {
      output: text(subject),
      matches: json({ count: 0, mode: 'replace' }),
    });
    const worked = summariseOutputs(regex, {
      output: text('XlphX betX'),
      matches: json({ count: 3, mode: 'replace' }),
    });

    expect(missed).toBe('Nothing replaced');
    expect(worked).toBe('3 replaced');
    expect(missed).not.toBe(worked);
    expect(missed).not.toBe(subject);
  });

  /*
   * A run produces every port its tool declares, so the branch below is
   * unreachable from the app - but `ToolOutputs` is a record and the type
   * demands an answer. The honest one is the value itself: a node that has an
   * answer and no measurement of it should print the answer, not nothing.
   */
  it('falls back to the answer itself when the measuring port did not arrive', () => {
    expect(summariseOutputs(structured, { output: text('[\n  1\n]') })).toBe('[');
  });

  it('is still null when the node has produced nothing at all', () => {
    expect(summariseOutputs(structured, {})).toBeNull();
    expect(summariseOutputs(diff, null)).toBeNull();
  });

  /*
   * AND THE ONE THAT SAYS THE MECHANISM IS REACHABLE AT ALL. Every assertion
   * above builds its own outputs, so all of them would pass against a manifest
   * in which no port declared `measuredBy`. This asks the manifest, and it is
   * the line a tool added later has to come past.
   */
  it('is declared by exactly the three tools whose answer is a serialisation', () => {
    // Through the DECLARED type rather than the const literal, for the same
    // reason the report test below reads it that way.
    const entries: readonly ToolManifestEntry[] = TOOL_MANIFEST;
    const measured = entries
      .filter((entry) => entry.outputs[0]?.measuredBy !== undefined)
      .map((entry) => `${entry.id}.${entry.outputs[0]?.measuredBy ?? ''}`);

    expect(measured).toEqual(['structured-data.data', 'diff.changes', 'regex-tester.matches']);
  });

  /*
   * THE FOUR THAT DELIBERATELY KEEP THEIR FIRST LINE, asserted so that
   * "measure anything with a syntax" cannot quietly be applied to them.
   *
   *   - `hash` and `color-convert` produce ONE line and it is the whole
   *     answer; a measurement of it would be a character count.
   *   - `base64` encoding produces one line too. It is truncated with an
   *     ellipsis that says so, and it varies with the input, which is the
   *     property the four fixed above did not have.
   *   - `text-convert` serves Markdown, HTML and plain text from one port, so
   *     no static declaration could separate them - and for two of the three
   *     the first line is the document's own title or opening sentence.
   */
  it.each(['hash', 'color-convert', 'base64', 'text-convert'] as const)(
    '%s keeps the first line of its answer',
    (id) => {
      const entry = getManifestEntry(id);
      expect(entry.outputs[0]?.measuredBy).toBeUndefined();
      expect(summariseOutputs(entry, { output: text('# Title\nand more') })).toBe('# Title');
    },
  );
});

/* ========================================================================== *
 * What a node says it LOST
 * ========================================================================== */

describe('the loss a node prints on its own face', () => {
  /*
   * WHY THIS EXISTS AT ALL.
   *
   * A node summarises its first output and nothing else, which is the right
   * rule for an answer and the wrong one for a caveat: every tool's losses are
   * on a `report`-presented port, and every one of those is the second or third
   * port. So round three's four new reports would have been sentences the
   * product really produced, on ports nobody has to wire, and invisible to
   * anybody standing in front of the canvas.
   *
   * The argument is the one the JWT verdict already won. A node in the middle
   * of a chain is exactly where nobody opens the panel.
   */
  const structured = getManifestEntry('structured-data');

  const report = (notes: readonly { level: string; title: string }[]): ToolValue =>
    json({ summary: 'JSON → CSV', notes });

  it('prints a warn note from a report port', () => {
    expect(
      lossSummary(structured, {
        output: text('a,b\n1,2'),
        report: report([
          { level: 'warn', title: 'The nested value at $[0].user was kept as JSON' },
        ]),
      }),
    ).toBe('The nested value at $[0].user was kept as JSON');
  });

  it('leads with the first and counts the rest', () => {
    // Two half-sentences at 224px are two unreadable sentences. One whole one
    // and a count says there is more without making the first one useless.
    expect(
      lossSummary(structured, {
        report: report([
          { level: 'warn', title: 'Two numbers were rounded' },
          { level: 'warn', title: 'A stream became an array' },
          { level: 'warn', title: 'A column was absent from some rows' },
        ]),
      }),
    ).toBe('Two numbers were rounded · +2 more');
  });

  /*
   * THE NEGATIVE CONTROLS, and there are three because there are three ways
   * this could cry wolf.
   */
  it('says nothing when the report has no notes', () => {
    expect(lossSummary(structured, { output: text('a'), report: report([]) })).toBeNull();
  });

  it('says nothing about an info note', () => {
    // `info` is "here is what happened" - the format that was detected, a
    // stream that survived. Putting it on a node would mean a warning on almost
    // every conversion this tool performs.
    expect(
      lossSummary(structured, {
        report: report([{ level: 'info', title: 'Read as a stream of 2 documents' }]),
      }),
    ).toBeNull();
  });

  it('ignores warn notes that are not on a report port', () => {
    /*
     * `regex-tester` carries `warn` notes about the PATTERN on a `regex`-
     * presented port - "your pattern has slashes around it" is advice, not a
     * loss. Reading notes from any json port would have put that on a node's
     * face, which is the note that trains people to ignore the channel.
     */
    const regex: ToolManifestEntry = getManifestEntry('regex-tester');
    expect(regex.outputs.some((port) => port.presentation === 'report')).toBe(false);
    expect(
      lossSummary(regex, {
        output: text('result'),
        matches: json({ count: 1, notes: [{ level: 'warn', title: 'Pattern has slashes' }] }),
      }),
    ).toBeNull();
  });

  it('is null for a node that has not produced anything', () => {
    expect(lossSummary(structured, null)).toBeNull();
  });

  it('stays inside the limit', () => {
    const summary = lossSummary(structured, {
      report: report([{ level: 'warn', title: 'x'.repeat(5_000) }]),
    });
    expect(summary?.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
  });

  /*
   * AND THE ONE THAT SAYS THE CHANNEL IS REACHABLE AT ALL.
   *
   * Every assertion above builds its own payload, so all of them would pass
   * against a tool that never produces a `report` port. This asks the manifest.
   */
  it('is a channel eight tools actually have', () => {
    /*
     * Two of these had a `report` port before round three - the two binary
     * tools, which is where the shape was invented. Four gained one, and they
     * are exactly the four whose losses the matrix recorded as silent.
     *
     * `color-convert` is the seventh, added in round nine. It was the only
     * shipped tool that changes values and had nowhere to say so, which is why
     * four findings in `docs/test-findings.md` are one absence, and why the
     * matrix cell recording its clipping as `lossy, told` could not be made
     * true by rewording it.
     *
     * `timestamp` is the eighth, and had one from its first commit: a unit
     * read off a number's size, a clock change and a leap second are all
     * losses, and a tool that can lose something ships with the channel.
     */
    // Read through the DECLARED type rather than off the const literal: the
    // literal's inferred type has no `presentation` on the ports that do not
    // carry one, so the predicate would not compile against it.
    const entries: readonly ToolManifestEntry[] = TOOL_MANIFEST;
    const withReports = entries
      .filter((entry) => entry.outputs.some((port) => port.presentation === 'report'))
      .map((entry) => entry.id);

    expect(withReports).toEqual([
      'base64',
      'structured-data',
      'jwt-decode',
      'color-convert',
      'image-convert',
      'video-remux',
      'text-convert',
      'timestamp',
    ]);
  });
});

/* -------------------------------------------------------------------------- *
 * A note whose shape is wrong
 * -------------------------------------------------------------------------- */

describe('a report port carrying something that is not a note', () => {
  /*
   * `lossSummary` reads a payload off a port and puts it on a node's face, and
   * every guard on the way is untested by construction: the tools in this
   * repository all produce well-formed notes, so nothing exercises the branch
   * that decides what to do when one does not. Break the type guard and a note
   * whose title is a number reaches `clip`, which calls `String#replace` on it
   * and throws - out of a render, from a port, which is the one thing a summary
   * must never do.
   */
  const entry = getManifestEntry('structured-data');
  const port = entry.outputs.find((candidate) => candidate.presentation === 'report');

  const withNotes = (notes: unknown): Parameters<typeof lossSummary>[1] => {
    expect(port).toBeDefined();
    return { [port?.id ?? 'report']: json({ notes }) };
  };

  it('ignores a note whose title is not a string', () => {
    expect(lossSummary(entry, withNotes([{ level: 'warn', title: 7 }]))).toBeNull();
    expect(lossSummary(entry, withNotes([{ level: 'warn', title: null }]))).toBeNull();
    expect(lossSummary(entry, withNotes([{ level: 'warn' }]))).toBeNull();
  });

  it('ignores a note whose title is the empty string', () => {
    // An empty title on a node is an empty "Lossy ·" prefix over nothing at
    // all, which reads as a rendering fault rather than as a caveat.
    expect(lossSummary(entry, withNotes([{ level: 'warn', title: '' }]))).toBeNull();
  });

  it('still reads the well-formed ones beside them', () => {
    // The control: the guards above must not be "return null for everything".
    expect(
      lossSummary(
        entry,
        withNotes([
          { level: 'warn', title: 7 },
          { level: 'warn', title: 'A real loss' },
        ]),
      ),
    ).toBe('A real loss');
  });
});
