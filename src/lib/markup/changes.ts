import rehypeParse from 'rehype-parse';
import { unified } from 'unified';

import type { Nodes as HastNodes, RootContent } from 'hast';

/**
 * WHAT THE NORMALISING ROUND TRIP DID TO THE MARKUP.
 *
 * `HTML → HTML` is a sanitise pass and a normalise pass, and the normalise half
 * runs the document through Markdown - so it is bounded by what Markdown can
 * express. Measured, on real input: `class` and `data-*` attributes are
 * dropped, `<img width>` is dropped, a `colspan` becomes an empty cell, and a
 * `<table>` with no header GAINS AN EMPTY HEADER ROW that was not in the input.
 *
 * The sanitising half is correct and necessary. The inventing half is not, and
 * nothing reported either. This is the instrument that lets the tool say which
 * happened: it parses both documents and compares what is THERE, rather than
 * asserting a list of transformations somebody wrote down by reading the code.
 * A change to the pipeline that starts dropping something new shows up as a new
 * note rather than as nothing at all.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It is not a tree diff, and it is not trying
 * to be: matching nodes between two trees needs a similarity metric, and a
 * wrong match produces a confident wrong sentence - which is the failure this
 * whole round is about. Counting what each document CONTAINS is a question with
 * one answer, and the three answers it gives - an attribute that is no longer
 * anywhere, an element that is no longer anywhere, an element that was not
 * there before - are the three that matter.
 *
 * TWO CONSEQUENCES OF THAT CHOICE, STATED RATHER THAN HIDDEN:
 *
 *   - An attribute whose VALUE changed is not reported, because the name is
 *     still there. The one case in this app is `id`, which the sanitiser
 *     namespaces to `user-content-*` on purpose and says so in its own
 *     documentation - so the silence here is not the same silence.
 *   - An element that moved is not reported either, only one that appeared or
 *     disappeared. A `<p>` that gained a parent is the same `<p>`, and calling
 *     that a loss would put a note on almost every document.
 */

export interface MarkupChange {
  readonly kind: 'attribute-dropped' | 'element-dropped' | 'element-added';
  /** The tag or attribute name, as it is written in HTML. */
  readonly name: string;
}

/**
 * What a document CONTAINS, which is all either side of a comparison needs.
 *
 * Exported because one caller cannot hand over a document. Measuring what the
 * allow-list removes from a Markdown source means looking at the tree BEFORE
 * the sanitiser, and this repository does not have unsanitised HTML strings in
 * it - a census is a set of names, so there is nothing in one to render, copy,
 * put on a port or accidentally return.
 */
export interface Census {
  readonly elements: ReadonlyMap<string, number>;
  readonly attributes: ReadonlySet<string>;
}

/** hast spells attributes as JSX-ish property names; HTML authors do not. */
const ATTRIBUTE_NAMES: Readonly<Record<string, string>> = {
  className: 'class',
  htmlFor: 'for',
  colSpan: 'colspan',
  rowSpan: 'rowspan',
  ariaLabel: 'aria-label',
  ariaHidden: 'aria-hidden',
};

function attributeName(property: string): string {
  const known = ATTRIBUTE_NAMES[property];
  if (known !== undefined) return known;
  // `dataFooBar` is `data-foo-bar`; anything else camelCase is hyphenated the
  // same way, which is hast's own rule read backwards.
  return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** What a document contains, parsed from its markup. */
export function censusOfHtml(html: string): Census {
  return censusOf(unified().use(rehypeParse, { fragment: true }).parse(html));
}

/** The same, from a tree that already exists. */
export function censusOf(tree: HastNodes): Census {
  const elements = new Map<string, number>();
  const attributes = new Set<string>();

  const walk = (node: RootContent | HastNodes): void => {
    if (node.type === 'element') {
      elements.set(node.tagName, (elements.get(node.tagName) ?? 0) + 1);
      for (const [property, value] of Object.entries(node.properties)) {
        // An attribute present and empty is still present; only `undefined`
        // and `null` mean the parser did not see one.
        if (value === undefined || value === null || value === false) continue;
        attributes.add(attributeName(property));
      }
    }
    if ('children' in node) for (const child of node.children) walk(child);
  };

  walk(tree);
  return { elements, attributes };
}

/**
 * Every element and attribute the second document has that the first does not,
 * and the other way round.
 *
 * Ordered so the losses come before the inventions, because a person reading
 * this wants "what did I lose" first.
 */
export function compareMarkup(before: string, after: string): readonly MarkupChange[] {
  return compareCensus(censusOfHtml(before), censusOfHtml(after));
}

/** The comparison itself, for a caller that already has both censuses. */
export function compareCensus(first: Census, second: Census): readonly MarkupChange[] {
  const changes: MarkupChange[] = [];

  for (const name of first.attributes) {
    if (!second.attributes.has(name)) changes.push({ kind: 'attribute-dropped', name });
  }

  for (const [name, count] of first.elements) {
    if ((second.elements.get(name) ?? 0) < count) changes.push({ kind: 'element-dropped', name });
  }

  for (const [name, count] of second.elements) {
    if ((first.elements.get(name) ?? 0) < count) changes.push({ kind: 'element-added', name });
  }

  return changes;
}
