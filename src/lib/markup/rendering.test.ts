import { describe, expect, it } from 'vitest';

import { compareRendered, renderedCensusOfHtml, type RenderedCensus } from './rendering';

/**
 * ONE TEST PER RULE, AND ITS OPPOSITE.
 *
 * The pasted-HTML corpus holds the notes built on this census to three
 * engines' pixels, document by document. What it cannot do is isolate a rule:
 * a `<div>` whose unwrapping would join two lines is always replaced by the
 * paragraphs the round trip writes, so no corpus document decides rule 4's
 * proviso. These do, each beside the case the rule must NOT forgive - which
 * is the direction a rule that has grown too kind fails in.
 */

const counted = (census: RenderedCensus, tag: string): number =>
  [...census.rules.values()].reduce((sum, tags) => sum + (tags.get(tag) ?? 0), 0);

const count = (html: string, tag: string): number => counted(renderedCensusOfHtml(html), tag);

describe('rule 1: one rendering under two names', () => {
  it.each([
    ['<p><b>x</b></p>', '<p><strong>x</strong></p>'],
    ['<p><i>x</i></p>', '<p><em>x</em></p>'],
    ['<p><strike>x</strike></p>', '<p><del>x</del></p>'],
    ['<p><tt>x</tt></p>', '<p><code>x</code></p>'],
    ['<p><var>x</var></p>', '<p><em>x</em></p>'],
  ])('is no change from %s to %s', (before, after) => {
    expect(compareRendered(renderedCensusOfHtml(before), renderedCensusOfHtml(after))).toEqual([]);
  });

  it.each([
    ['a bold that went', '<p><b>x</b></p>', '<p>x</p>', 'b'],
    ['a highlight that became italics', '<p><mark>x</mark></p>', '<p><em>x</em></p>', 'mark'],
    ['code that became italics', '<p><code>x</code></p>', '<p><em>x</em></p>', 'code'],
  ])('is a change for %s', (_label, before, after, tag) => {
    const changes = compareRendered(renderedCensusOfHtml(before), renderedCensusOfHtml(after));
    expect(changes).toContainEqual({ kind: 'element-dropped', name: tag });
  });
});

describe('rule 2: no rendering of its own', () => {
  it('does not count a span, an abbreviation with no title or a link with no address', () => {
    const html = '<p><span>a</span> <abbr>b</abbr> <a>c</a></p>';
    expect([count(html, 'span'), count(html, 'abbr'), count(html, 'a')]).toEqual([0, 0, 0]);
  });

  it('counts an abbreviation with a title and a link with an address', () => {
    const html = '<p><abbr title="t">b</abbr> <a href="https://example.com">c</a></p>';
    expect([count(html, 'abbr'), count(html, 'a')]).toEqual([1, 1]);
  });

  it('counts anything that aligns or hides itself', () => {
    expect(count('<div align="center"><p>x</p></div>', 'div')).toBe(1);
    expect(count('<p>a <span hidden>b</span></p>', 'span')).toBe(1);
  });

  it('leaves an attribute that draws nothing to the attribute census', () => {
    // A `dir` or a `class` is lost by name, and said by name, elsewhere.
    expect(count('<div dir="auto" class="x"><p>x</p></div>', 'div')).toBe(0);
  });
});

describe('rule 3: already in effect', () => {
  it('does not count code inside pre, or an italic inside an italic', () => {
    expect(count('<pre><code>x</code></pre>', 'code')).toBe(0);
    expect(count('<p><em>a <i>b</i></em></p>', 'i')).toBe(0);
  });

  it('counts code outside pre, and a bold inside a bold, which is bolder', () => {
    expect(count('<p><code>x</code></p>', 'code')).toBe(1);
    expect(count('<p><b>a <strong>b</strong></b></p>', 'strong')).toBe(1);
  });
});

describe('rule 4: a block that draws nothing and joins nothing', () => {
  it('does not count a wrapper around blocks, or one holding a line on its own', () => {
    expect(count('<div><p>a</p><p>b</p></div>', 'div')).toBe(0);
    expect(count('<h2>t</h2><div>a line</div><p>b</p>', 'div')).toBe(0);
    expect(count('<section><h2>t</h2></section>', 'section')).toBe(0);
  });

  it('counts divs that are the only thing keeping two runs of text apart', () => {
    // Unwrapped, "one" and "two" would be one line.
    expect(count('<div>one</div>two', 'div')).toBe(1);
    expect(count('<blockquote>a <div>b</div> c</blockquote>', 'div')).toBe(1);
  });

  it('counts a block that draws something', () => {
    expect(count('<blockquote><p>a</p></blockquote>', 'blockquote')).toBe(1);
    expect(count('<details><p>a</p></details>', 'details')).toBe(1);
  });
});

describe('rule 5: row groups', () => {
  it('does not count a thead or a tbody, and still counts the rows', () => {
    const html =
      '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>d</td></tr></tbody></table>';
    expect([count(html, 'thead'), count(html, 'tbody'), count(html, 'tr')]).toEqual([0, 0, 2]);
  });
});
