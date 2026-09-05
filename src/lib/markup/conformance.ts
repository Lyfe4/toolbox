import rehypeParse from 'rehype-parse';
import { unified } from 'unified';

import type { Nodes } from 'hast';

/**
 * COMPARING TWO PIECES OF HTML FOR SAMENESS.
 *
 * The specs compare bytes. We compare the DOM the bytes mean, and the reason is
 * that byte equality asks a question this converter never promised to answer.
 *
 * Measured, before this existed: 475 of 652 CommonMark examples "failed" on a
 * byte comparison, and almost every one of them was spelling. `<hr />` against
 * `<hr>`. `&quot;` against `"`. `&#x26;` against `&amp;`. A `<tbody>` the HTML
 * parser inserts because the spec's expected output omits it. Not one of those
 * is a difference a browser can see, and chasing them would mean rewriting the
 * serialiser to imitate cmark rather than to emit good HTML.
 *
 * So: parse both sides with the same parser and compare the trees. That is
 * strictly the right question - two documents are the same if they parse the
 * same - and it is not a weakening, because everything that genuinely differs
 * still differs. Raw HTML against escaped text, a dropped attribute, an
 * element the sanitiser removed: all of those change the tree, and all of them
 * still fail.
 */

const parser = unified().use(rehypeParse, { fragment: true });

/** Elements where whitespace is content rather than formatting. */
const VERBATIM = new Set(['pre', 'code', 'textarea', 'script', 'style']);

type Canonical = readonly [string, readonly (readonly [string, string])[], readonly unknown[]];

/**
 * The one normalisation applied on top of parsing: formatting whitespace.
 *
 * A whitespace-only text node containing a newline is the line break between
 * two block elements, and the spec's expected output is pretty-printed while
 * ours is not. Inside `pre` and `code` it is content and is left alone.
 *
 * Note what is NOT normalised: a single space between two inline elements has
 * no newline in it, so it survives, and `<em>a</em> <em>b</em>` still differs
 * from `<em>a</em><em>b</em>`.
 */
function isFormatting(value: string): boolean {
  return value.trim() === '' && value.includes('\n');
}

function canonicalise(node: Nodes, verbatim: boolean): unknown {
  if (node.type === 'text') {
    if (!verbatim && isFormatting(node.value)) return null;
    return node.value === '' ? null : ['#', node.value];
  }

  if (node.type === 'comment') return ['!', node.value];

  if (node.type === 'element') {
    const inner = verbatim || VERBATIM.has(node.tagName);
    const properties = Object.entries(node.properties)
      .filter(([, value]) => value !== undefined && value !== null && value !== false)
      .map(([key, value]): readonly [string, string] => [
        key,
        Array.isArray(value) ? value.join(' ') : String(value),
      ])
      // Attribute order is not part of what HTML means.
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));

    const children = node.children
      .map((child) => canonicalise(child, inner))
      .filter((child) => child !== null);

    return [node.tagName, properties, children] satisfies Canonical;
  }

  if ('children' in node) {
    return node.children
      .map((child) => canonicalise(child, verbatim))
      .filter((child) => child !== null);
  }

  return null;
}

/**
 * A string two documents share exactly when they mean the same thing.
 *
 * Trailing whitespace is trimmed first: the specs end every expected document
 * with a newline and we do not, which is a property of the file rather than of
 * the document.
 */
export function canonicalHtml(html: string): string {
  return JSON.stringify(canonicalise(parser.parse(html.replace(/\s+$/, '')), false));
}
