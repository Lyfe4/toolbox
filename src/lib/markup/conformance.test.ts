import { describe, expect, it } from 'vitest';

import { canonicalHtml } from './conformance';
import { markdownToHtml } from './pipelines';
import commonmarkSpec from './spec/commonmark.json';
import gfmSpec from './spec/gfm.json';

/**
 * THE OBJECTIVE NUMBER.
 *
 * The CommonMark specification ships its examples as data, and so does GFM.
 * Running them is the difference between "the converter seems good" and "the
 * converter passes 624 of 652, and here is the list of the other 28 with a
 * reason against each".
 *
 * The fixtures are CHECKED IN rather than fetched:
 *
 *   - CommonMark 0.31.2, from spec.commonmark.org/0.31.2/spec.json
 *   - GFM's five extension sections, extracted from cmark-gfm's spec.txt
 *
 * A test suite that reaches the network is a test suite that fails on a train,
 * and this project's whole claim is that it needs no network. Pinning the
 * version also means an upstream spec revision arrives as a deliberate update
 * with a visible diff, rather than as a build that broke overnight.
 *
 * WHAT IS COMPARED: the DOM, not the bytes. See conformance.ts for why, and
 * for the one normalisation applied on top.
 *
 * WHAT THE EXPECTED-FAILURE LISTS ARE FOR. They are exact, not a threshold. A
 * newly failing example fails this suite, and so does a newly PASSING one -
 * because an example that starts passing is either a fix worth recording or a
 * sign that the list has drifted from the truth. Every entry carries the
 * reason it is there, so the list reads as a description of the converter's
 * boundary rather than as a pile of exclusions.
 */

interface SpecCase {
  readonly example: number;
  readonly section: string;
  readonly markdown: string;
  readonly html: string;
}

/* ========================================================================== *
 * CommonMark: the 28 examples that do not match, and why
 * ========================================================================== */

/**
 * THE SANITISER REMOVED SOMETHING THE SPEC PASSES THROUGH.
 *
 * All but three of the remaining failures, and the least interesting of them:
 * cmark copies raw HTML to the output verbatim, and this tool refuses to. An
 * unknown element (`<foo>`, `<bar>`), a `<script>`, a `class` or `id` the
 * allow-list does not permit - all of it goes, by design and on purpose,
 * because the output of this tool is meant to be safe to paste somewhere that
 * renders it.
 *
 * These are not defects to be fixed. They are the product, measured.
 */
const SANITISED = [
  150, 152, 153, 154, 163, 164, 169, 170, 171, 172, 173, 176, 178, 201, 491, 524, 536, 613, 614,
  615, 616, 617,
];

/**
 * URL SCHEMES THIS TOOL DOES NOT ALLOW.
 *
 * `irc:`, `a+b+c:`, `made-up-scheme:` and `localhost:5001/foo` are all links
 * per CommonMark and all rejected by the protocol allow-list, which permits
 * http, https, mailto and tel and nothing else.
 *
 * They no longer render as a dead `<a>` with no destination - the link is
 * unwrapped and its text kept - which is a better answer than either the
 * spec's or the previous one, but it is still not the spec's answer.
 */
const SCHEME_NOT_ALLOWED = [596, 598, 599, 601];

/**
 * ONE DELIBERATE NORMALISATION: the scheme's case.
 *
 * `<MAILTO:FOO@BAR.BAZ>` produces `href="mailto:FOO@BAR.BAZ"` where the spec
 * expects `MAILTO:` preserved. Schemes are case-insensitive - RFC 3986 - so
 * both are the same URL, and lowercasing is what lets the allow-list match at
 * all. Before it, the example did not merely differ: it lost its href.
 */
const SCHEME_LOWERCASED = [597];

/**
 * A RELATIVE URL CONTAINING A COLON IS REJECTED.
 *
 * `[link](foo\)\:)` has the destination `foo):`, which is a relative
 * reference: `)` cannot appear in a scheme, so there is no scheme here.
 * hast-util-sanitize looks for the first `:` and treats everything before it
 * as the protocol, decides `foo)` is not allowed, and drops the href.
 *
 * Upstream, obscure, and with no clean fix from outside: correcting it would
 * mean re-implementing the protocol check rather than configuring it.
 */
const RELATIVE_URL_WITH_COLON = [500];

/*
 * TWELVE EXAMPLES LEFT THIS LIST when HTML comments stopped being dropped.
 *
 * Seven were comments outright. The other five were a surprise worth
 * recording: `<?php ... ?>` and `<![CDATA[ ... ]]>` are HTML block types 3
 * and 5 in the spec, and an HTML parser represents both as COMMENT nodes - so
 * the schema that dropped comments was dropping those too, and allowing them
 * back fixed all five without a line of code aimed at either.
 */

const COMMONMARK_KNOWN_FAILURES = [
  ...SANITISED,
  ...SCHEME_NOT_ALLOWED,
  ...SCHEME_LOWERCASED,
  ...RELATIVE_URL_WITH_COLON,
].sort((a, b) => a - b);

/* ========================================================================== *
 * GFM extensions: the 3 that do not match, and why
 * ========================================================================== */

/**
 * TASK LISTS CARRY GITHUB'S CLASSES.
 *
 * remark-gfm emits `class="contains-task-list"` and `class="task-list-item"`,
 * which the spec's expected output does not have - but github.com does, on
 * every rendered README. The extra attribute is the only difference; the
 * checkbox, its state and its disabled flag all match.
 *
 * Ours is closer to what GitHub actually serves than the spec text is, so
 * there is nothing here to fix.
 */
const TASK_LIST_CLASSES = [279, 280];

/**
 * `ftp://` IS NOT LINKIFIED.
 *
 * GFM's extended autolink literals cover http, https and ftp.
 * micromark-extension-gfm-autolink-literal@2.1.0 covers the first two:
 *
 *   dev/lib/syntax.js:363   if (protocol === 'http' || protocol === 'https')
 *
 * Upstream, and left alone deliberately. Working around it would mean writing
 * a second linkifier beside the first, duplicating its trailing-punctuation
 * rules - which are the hard part - to support a scheme that Chrome and
 * Firefox both removed in 2021.
 */
const FTP_AUTOLINK = [628];

const GFM_KNOWN_FAILURES = [...TASK_LIST_CLASSES, ...FTP_AUTOLINK].sort((a, b) => a - b);

/* ========================================================================== */

function failuresFor(
  cases: readonly SpecCase[],
  options: { headingIds: boolean; linkify: boolean },
): number[] {
  const failed: number[] = [];

  for (const testCase of cases) {
    let got: string;
    try {
      got = markdownToHtml(testCase.markdown, options);
    } catch (error) {
      got = `THREW: ${String(error)}`;
    }
    if (canonicalHtml(got) !== canonicalHtml(testCase.html)) failed.push(testCase.example);
  }

  return failed;
}

describe('CommonMark 0.31.2', () => {
  /*
   * `linkify: false`, because GFM's autolink literals are not CommonMark and
   * leaving them on would fail five examples for implementing a different
   * specification. `headingIds: false` for the same reason: the ids are ours,
   * not the spec's.
   */
  const failures = failuresFor(commonmarkSpec, {
    headingIds: false,
    linkify: false,
  });

  it('fails exactly the examples that are known to fail', () => {
    expect(failures).toEqual(COMMONMARK_KNOWN_FAILURES);
  });

  it('passes 624 of 652', () => {
    // Stated as a number as well as a list, because the number is the thing
    // anyone actually wants to know.
    const passed = commonmarkSpec.length - failures.length;
    expect(`${String(passed)}/${String(commonmarkSpec.length)}`).toBe('624/652');
  });

  it('has no failures outside raw HTML, links and autolinks', () => {
    /*
     * The shape of the failure set matters as much as its size. Every
     * remaining failure is about raw HTML or about a URL - none is about
     * emphasis, lists, tables, code, headings or any other Markdown
     * construct. If one ever appears in another section, that is a parser
     * problem rather than a policy one, and this is what says so.
     */
    const sections = new Set(
      (commonmarkSpec as SpecCase[])
        .filter((testCase) => failures.includes(testCase.example))
        .map((testCase) => testCase.section),
    );

    expect([...sections].sort()).toEqual([
      'Autolinks',
      'HTML blocks',
      'Link reference definitions',
      'Links',
      'Raw HTML',
    ]);
  });
});

describe('GFM extensions', () => {
  const failures = failuresFor(gfmSpec, { headingIds: false, linkify: true });

  it('fails exactly the examples that are known to fail', () => {
    expect(failures).toEqual(GFM_KNOWN_FAILURES);
  });

  it('passes 21 of 24', () => {
    const passed = gfmSpec.length - failures.length;
    expect(`${String(passed)}/${String(gfmSpec.length)}`).toBe('21/24');
  });

  it('passes every table, strikethrough and tagfilter example', () => {
    // The three sections with no known failures at all, named so that a
    // regression in any of them is a failure with a description on it.
    const clean = (gfmSpec as SpecCase[]).filter((testCase) =>
      /Tables|Strikethrough|Disallowed/.test(testCase.section),
    );

    expect(clean.length).toBe(11);
    expect(clean.filter((testCase) => failures.includes(testCase.example))).toEqual([]);
  });
});
