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
 *     still there. The one case in this app is `id`, which the pipeline
 *     namespaces to `user-content-*` on purpose - and "documented elsewhere"
 *     turned out to mean "in a comment", not on screen. A census therefore
 *     also carries the identifier VALUES, which is the one attribute whose
 *     value this app is known to rewrite; see `renamedIdentifiers`.
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
  /**
   * Every `id` and `name` the document DECLARES, as written.
   *
   * The one exception to "a census is a set of names": these are values, and
   * they are here because they are the only values in this app that a pipeline
   * rewrites. A set of identifiers is still nothing anybody can render - there
   * is no markup in it, nothing to copy and nothing to put on a port - which
   * is the property that made a census safe to hand across a module boundary
   * in the first place.
   *
   * Not every `href`: only the in-document ones, below.
   */
  readonly identifiers: ReadonlySet<string>;
  /**
   * What every in-document link points at - the `x` of `href="#x"`.
   *
   * The other half of the identifier question, and the half with the visible
   * consequence. A link whose target is not an identifier in the SAME document
   * is a link that goes nowhere, and a document can acquire one without losing
   * an element or an attribute: `HTML → HTML (normalised)` takes the document
   * out to Markdown, which has no spelling for a heading's id, and the id
   * comes back as a slug of the heading's TEXT. Every link to the old name is
   * then dead, and both documents still contain exactly one `id` and one
   * `href`. See `deadFragments`.
   */
  readonly fragments: ReadonlySet<string>;
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
  const identifiers = new Set<string>();
  const fragments = new Set<string>();

  const walk = (node: RootContent | HastNodes): void => {
    if (node.type === 'element') {
      elements.set(node.tagName, (elements.get(node.tagName) ?? 0) + 1);
      for (const [property, value] of Object.entries(node.properties)) {
        // An attribute present and empty is still present; only `undefined`
        // and `null` mean the parser did not see one.
        if (value === undefined || value === null || value === false) continue;
        attributes.add(attributeName(property));
        if (typeof value !== 'string' || value === '') continue;
        if (property === 'id' || property === 'name') identifiers.add(value);
        // `#` alone is the top of the page in every browser and points at no
        // identifier by design, so it is not a fragment anybody can break.
        if (property === 'href' && value.startsWith('#') && value.length > 1)
          fragments.add(value.slice(1));
      }
    }
    if ('children' in node) for (const child of node.children) walk(child);
  };

  walk(tree);
  return { elements, attributes, identifiers, fragments };
}

/**
 * Links in a document that point at nothing in it, because WE moved the target.
 *
 * The second clause is the whole of it. A document can arrive with a dead
 * anchor already in it - `<a href="#gone">` where nothing is called `gone` -
 * and reporting that would be blaming the author for something the conversion
 * did not do. So a fragment is only counted when the name it points at, with
 * or without the prefix, is one the SOURCE document declared: the link is dead
 * because the identifier it named was renamed or dropped on the way through.
 */
export function deadFragments(
  declared: ReadonlySet<string>,
  after: Census,
  prefix: string,
): readonly string[] {
  const dead: string[] = [];

  for (const fragment of after.fragments) {
    if (after.identifiers.has(fragment)) continue;
    const bare = fragment.startsWith(prefix) ? fragment.slice(prefix.length) : fragment;
    if (declared.has(fragment) || declared.has(bare)) dead.push(fragment);
  }

  return dead;
}

/** Identifiers the source declared that are in the result under no spelling. */
export function droppedIdentifiers(
  declared: ReadonlySet<string>,
  after: Census,
  prefix: string,
): readonly string[] {
  return [...declared].filter(
    (identifier) =>
      !after.identifiers.has(identifier) && !after.identifiers.has(`${prefix}${identifier}`),
  );
}

/**
 * Identifiers the second document carries under a prefix the first did not.
 *
 * `id="location"` going in and `id="user-content-location"` coming out is a
 * value the author wrote that is not in the output, and `compareCensus` cannot
 * see it because `id` is present on both sides. It is deliberate - an id can
 * shadow a global wherever the output is pasted, which is the whole reason the
 * prefix exists - and it is still something that went in and did not come out.
 *
 * An identifier the pipeline INVENTED is not a rename: a heading slug is a new
 * id under the same prefix, and the un-prefixed form was never in the input.
 * The question is therefore asked of the input's own identifiers, one at a
 * time, which is what keeps this from reporting every document with a heading
 * in it - and for a Markdown source "the input's own" means the ones the
 * author really typed, which is `markdownAuthorIdentifiers` rather than a
 * census of the tree.
 */
export function renamedIdentifiers(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  prefix: string,
): readonly string[] {
  const renamed: string[] = [];

  for (const identifier of before) {
    if (identifier.startsWith(prefix)) continue;
    if (after.has(identifier)) continue;
    if (after.has(`${prefix}${identifier}`)) renamed.push(identifier);
  }

  return renamed;
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
