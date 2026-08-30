import { describe, expect, it } from 'vitest';

import { detectFormat } from './detect';

/**
 * AUTO-DETECTION.
 *
 * The failure this is built to avoid is not "picked the less likely option" -
 * it is "said Markdown with confidence about a fragment of HTML", because the
 * user then has no reason to look at the source control. So the tests come in
 * two halves: it must be right on clear cases, and honest on unclear ones.
 */

describe('clear cases', () => {
  it.each([
    ['an ATX heading', '# Title\n\nSome text.\n'],
    ['a bullet list', '- one\n- two\n'],
    ['an ordered list', '1. one\n2. two\n'],
    ['a blockquote', '> quoted\n'],
    ['a fenced code block', '```js\nconst a = 1;\n```\n'],
    ['a GFM table', '| a | b |\n| - | - |\n| 1 | 2 |\n'],
    ['an inline link', 'See [the docs](https://example.com).\n'],
    ['strong emphasis', 'Some **bold** text.\n'],
    ['strikethrough', 'Some ~~struck~~ text.\n'],
    ['a thematic break', 'Above\n\n---\n\nBelow\n'],
    ['a footnote definition', 'Text[^1].\n\n[^1]: The note.\n'],
    ['a link reference definition', 'See [docs][ref].\n\n[ref]: https://example.com\n'],
  ])('is confident that %s is Markdown', (_name, source) => {
    const detection = detectFormat(source);

    expect(detection.format).toBe('markdown');
    expect(detection.confidence).toBe('confident');
  });

  it.each([
    ['a div', '<div class="note">Hello</div>'],
    ['a paragraph', '<p>Hello</p>'],
    ['a table', '<table><tr><td>1</td></tr></table>'],
    ['a full document', '<html><body><p>Hi</p></body></html>'],
    ['a list', '<ul><li>one</li></ul>'],
    ['a heading', '<h1>Title</h1>'],
    ['an anchor', '<a href="https://example.com">link</a>'],
  ])('is confident that %s is HTML', (_name, source) => {
    const detection = detectFormat(source);

    expect(detection.format).toBe('html');
    expect(detection.confidence).toBe('confident');
  });

  it('says what it found, not just what it chose', () => {
    expect(detectFormat('# Title\n').reason).toContain('ATX heading');
    expect(detectFormat('<div>x</div>').reason).toContain('<div');
  });
});

describe('things that look like markup but are not', () => {
  it.each([
    ['an autolink', 'Visit <https://example.com> today.\n'],
    ['a generic in a code span', 'Use `Array<T>` for that.\n'],
    ['a less-than in prose', 'When a < b, the loop exits.\n'],
    ['an arrow', 'The value goes from 1 -> 2.\n'],
  ])('does not call %s HTML', (_name, source) => {
    // The tag list is small and structural on purpose: Markdown documents are
    // full of angle brackets that are not markup, and sending a README down
    // the HTML pipeline would mangle it.
    expect(detectFormat(source).format).toBe('markdown');
  });
});

describe('honest about ambiguity', () => {
  it('lowers confidence for Markdown containing an HTML block', () => {
    const detection = detectFormat('# Title\n\n<div class="note">Aside</div>\n\nMore text.\n');

    expect(detection.format).toBe('markdown');
    expect(detection.confidence).toBe('assumed');
    expect(detection.reason).toContain('embedded HTML');
  });

  it('lowers confidence for HTML containing Markdown-looking text', () => {
    const detection = detectFormat('<div><p>Some **bold** text</p></div>');

    expect(detection.format).toBe('html');
    expect(detection.confidence).toBe('assumed');
  });

  it('resolves on where the markup starts, and says so', () => {
    // Markup at the very beginning is a document; markup further down is a
    // block inside Markdown. Either way the confidence drops.
    // A space before `**`, or it is not strong emphasis and the case is not
    // ambiguous at all - which is itself the point of the narrow patterns.
    const leading = detectFormat('<table><tr><td>a **b** c</td></tr></table>');
    const trailing = detectFormat('# Title\n\n<table><tr><td>x</td></tr></table>\n');

    expect(leading.format).toBe('html');
    expect(trailing.format).toBe('markdown');
    expect(leading.confidence).toBe('assumed');
    expect(trailing.confidence).toBe('assumed');
  });

  it('admits it is assuming for plain prose', () => {
    const detection = detectFormat('Just an ordinary sentence with no syntax in it.\n');

    // Markdown, because Markdown is a superset of plain prose: converting a
    // paragraph as Markdown returns the paragraph.
    expect(detection.format).toBe('markdown');
    expect(detection.confidence).toBe('assumed');
    expect(detection.reason).toContain('No markup');
  });

  it('admits it is assuming for empty input', () => {
    expect(detectFormat('   \n  ').confidence).toBe('assumed');
  });
});
