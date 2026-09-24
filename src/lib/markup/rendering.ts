import rehypeParse from 'rehype-parse';
import { unified } from 'unified';

import type { MarkupChange } from './changes';
import type { Element, Nodes as HastNodes, Root, RootContent } from 'hast';

/**
 * WHAT A READER CAN DISTINGUISH, COUNTED INSTEAD OF WHAT A TAG IS CALLED.
 *
 * The name census in `changes.ts` answers "which element names are in one
 * document and not the other", and it answers it correctly. The notes built on
 * it made a different claim - "could not carry", "was invented" - which is a
 * claim about what the document RENDERS AS, and any step in the pipeline that
 * renames without changing the rendering made that claim false. Five such
 * steps shipped: a `<thead>` the serialiser writes, `<b>` coming back as
 * `<strong>`, a `<pre>` coming back as `<pre><code>`, and a bare `<span>` and
 * a `<div>` wrapper that Markdown has no spelling for and nobody could see.
 * The first two were fixed by lists of exceptions; the last three were found
 * by round fifteen's probe, and a list is only ever as long as the last
 * incident. So this counts something else.
 *
 * WHAT IT COUNTS. Every element's contribution to the rendering, taken from
 * the one reference that says what that is - the HTML Standard's rendering
 * section, the user-agent stylesheet every engine starts from - and an
 * element that contributes nothing where it stands is not counted at all:
 *
 *   1. SAME RENDERING, DIFFERENT NAME. `b` and `strong` are one rule in the
 *      standard (`font-weight: bolder`), and so are four other groups. They
 *      are counted under the rule, not the name, so `<b>` becoming `<strong>`
 *      is not a change - and a `<b>` becoming NOTHING still is.
 *   2. NO RENDERING OF ITS OWN. The standard gives `<span>` no rule at all,
 *      `<abbr>` one only with a title, `<a>` one only with an href. Without
 *      those such an element draws nothing, so it is not counted. Any other
 *      attribute it carries is the attribute census's to report, by name -
 *      see `rendersByAttribute`.
 *   3. ITS RENDERING IS ALREADY IN EFFECT. `code` inside `pre` asks for a
 *      monospace font inside a box that already has one. Only the rules that
 *      are absolute rather than relative qualify: an italic inside an italic
 *      is still italic, but a `bolder` inside a bold is bolder again.
 *   4. A BLOCK THAT DRAWS NOTHING AND JOINS NOTHING. A `<div>` is
 *      `display: block` and nothing else - no margin, padding or border - so
 *      its children's margins collapse through it and unwrapping it changes no
 *      box, PROVIDED it does not end up joining two runs of text into one
 *      line. That proviso is the difference between `<div><p>…</p></div>` (a
 *      wrapper) and `<div>one</div><div>two</div>` (two lines), and it is
 *      decided here from the tree: all its children are blocks, or all its
 *      siblings are.
 *   5. A TABLE GROUP THE SERIALISER WRITES. `<thead>` and `<tbody>` group rows
 *      the table would group anyway; CSS makes an anonymous group where
 *      neither is written. Round ten's false note.
 *
 * WHAT HOLDS IT TO THAT. `src/tools/text-convert/spec/pasted-html.oracle.json`
 * is three real engines' answer, for seventy-one hand-written and pasted
 * documents, to whether a reader can see the difference; pasted-html.test.ts
 * holds every note built on this census to it. The rules are what the
 * standard says; the oracle is what the engines draw. On that corpus no
 * element note fires where no engine sees a difference, and none is missing
 * where all three do - the positive half fails if a rule here forgives
 * something every engine draws. They are not identical: WebKit kerns one glyph
 * differently across a span boundary, which the oracle's layout rule counts
 * as visible and no reader would see, and rule 2 does not.
 *
 * WHAT IT DOES NOT DO, stated rather than hidden:
 *
 *   - It does not model margin collapsing between SIBLINGS. A `<p>` that the
 *     round trip puts around loose text shows its margins or not depending on
 *     its neighbours' - measured: invisible after a heading at the end of a
 *     document, sixteen pixels in front of a `<div>` and eight at the top
 *     of a document, in all three engines - and a census cannot see its
 *     neighbours without matching nodes between two trees, which is the tree
 *     diff `changes.ts` explains the reasons for not building. So a
 *     paragraph is counted, and the note about it in `normalisation.ts` says
 *     only what is always true of it.
 *   - It reads the user-agent stylesheet, not the page the output is pasted
 *     into. A stylesheet that styles `span` makes every span visible. That is
 *     the same reference the respelling filter it replaces rested on, and it
 *     is the rendering a pasted document gets wherever nobody wrote one.
 *   - It does not judge the accessibility tree. `strong` and `b` expose
 *     different roles, and so do `code` and `p`; the oracle records those
 *     differences beside the pixels and they are reported in
 *     docs/test-findings.md rather than turned into notes. No screen reader
 *     announces any of them by default, which is a judgement and not a
 *     measurement, and it is written down as one.
 */

/**
 * RULE 1. Names that the standard gives one rendering between them, keyed by
 * the rule. HTML Standard §15.3.4 (phrasing content):
 *
 *   b, strong                       { font-weight: bolder }
 *   cite, dfn, em, i, var           { font-style: italic }
 *   code, kbd, samp, tt             { font-family: monospace }
 *   del, s, strike                  { text-decoration: line-through }
 *   ins, u                          { text-decoration: underline }
 *
 * `mark` is deliberately absent - a highlight is a rule of its own - and so is
 * `address`, which is italic but a block, so it is not the same rendering as
 * an `<em>`.
 */
const SAME_RENDERING: Readonly<Record<string, string>> = {
  b: 'bold',
  strong: 'bold',
  cite: 'italic',
  dfn: 'italic',
  em: 'italic',
  i: 'italic',
  var: 'italic',
  code: 'monospace',
  kbd: 'monospace',
  samp: 'monospace',
  tt: 'monospace',
  del: 'line-through',
  s: 'line-through',
  strike: 'line-through',
  ins: 'underline',
  u: 'underline',
};

/**
 * RULE 2. Elements the standard gives no rendering without one attribute. The
 * `abbr` rule is `abbr[title]`, the link rules are `a:link` and `a:visited`,
 * which need an `href`; `span` has no rule at all.
 */
const NO_RENDERING_BARE: ReadonlySet<string> = new Set(['span', 'abbr', 'a']);

/**
 * RULE 3. The absolute rules an ancestor can already have put in effect,
 * and the elements outside `SAME_RENDERING` that put them there.
 * `pre, listing, plaintext, xmp { font-family: monospace }` and
 * `address { font-style: italic }`. Line-through and underline are left out:
 * nested decorations are drawn once per decorating box, which is not a claim
 * the oracle has measured.
 */
const IDEMPOTENT: ReadonlySet<string> = new Set(['italic', 'monospace']);
const ALSO_SETS: Readonly<Record<string, string>> = {
  pre: 'monospace',
  listing: 'monospace',
  plaintext: 'monospace',
  xmp: 'monospace',
  address: 'italic',
};

/**
 * RULE 4. `display: block` and nothing else, in the standard's rendering
 * section: §15.3.3 (`div, figcaption, footer, form, header, main, search`),
 * §15.3.7 (`article, aside, hgroup, nav, section`) and §15.3.8 (`dt`).
 *
 * `blockquote`, `figure`, `p`, `pre` and the lists are block AND have margins,
 * `address` is italic, `center` centres, `details` hides, `dialog` is hidden
 * unless open - none of those draws nothing.
 *
 * User-agent stylesheets have sized an `<h1>` down inside a sectioning
 * element, which would make unwrapping a `<section>` around one visible. None
 * of the three engines the oracle runs does so now - measured on
 * `section-around-h1` in the corpus, which the positive half of the test
 * would turn red if one started again. Whether the standard's own text still
 * carries the rule was not checked; the engines are what the oracle reads.
 */
const DRAWS_NOTHING: ReadonlySet<string> = new Set([
  'div',
  'figcaption',
  'footer',
  'form',
  'header',
  'main',
  'search',
  'article',
  'aside',
  'hgroup',
  'nav',
  'section',
  'dt',
]);

/** Block-level in the standard's stylesheet: what a wrapper's neighbours must be. */
const BLOCK_LEVEL: ReadonlySet<string> = new Set([
  ...DRAWS_NOTHING,
  'address',
  'blockquote',
  'center',
  'dd',
  'details',
  'dialog',
  'dir',
  'dl',
  'fieldset',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'legend',
  'li',
  'listing',
  'menu',
  'ol',
  'p',
  'plaintext',
  'pre',
  'summary',
  'table',
  'ul',
  'xmp',
]);

/** RULE 5. Row groups that CSS would make anyway where neither is written. */
const ROW_GROUPS: ReadonlySet<string> = new Set(['thead', 'tbody']);

/**
 * What a document draws, as counts: for each rendering rule, which tags
 * carried it and how many times. A tag that contributed nothing where it stood
 * is in no entry.
 */
export interface RenderedCensus {
  readonly rules: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

type Parent = Root | Element;

/**
 * THE ATTRIBUTES THAT GIVE AN ELEMENT A RENDERING OF ITS OWN.
 *
 * Only these, and not every attribute, because an element note is about the
 * element: a `<div dir="auto">` that is unwrapped loses its `dir`, and that is
 * the attribute census's to say - it does, by name - while the `<div>` itself
 * still drew nothing. Counting the element for any attribute put a
 * "could not carry <div>" beside the true attribute note on a GitHub README's
 * DOM, where no engine draws a difference.
 *
 * These are the ones the rendering section's own selectors need: `a:link`
 * (`href`), `abbr[title]`, the `align` presentational hint, and `[hidden]`,
 * which is `display: none`.
 */
function rendersByAttribute(element: Element): boolean {
  const has = (name: string): boolean => {
    const value = element.properties[name];
    return value !== undefined && value !== null && value !== false;
  };
  if (has('align') || has('hidden')) return true;
  if (element.tagName === 'a') return has('href');
  if (element.tagName === 'abbr') return has('title');
  return false;
}

/** Text that draws something - not the whitespace a serialiser puts between blocks. */
function isInk(node: RootContent): boolean {
  return node.type === 'text' && node.value.trim() !== '';
}

/** Children that take part in layout: elements and text that is not whitespace. */
function laidOut(parent: Parent): readonly RootContent[] {
  return parent.children.filter(
    (child) => child.type === 'element' || (child.type === 'text' && isInk(child)),
  );
}

function allBlocks(nodes: readonly RootContent[]): boolean {
  return nodes.every((node) => node.type === 'element' && BLOCK_LEVEL.has(node.tagName));
}

/** Rule 4's proviso: unwrapping this element cannot join its text to a neighbour's. */
function joinsNothing(element: Element, parent: Parent): boolean {
  if (parent.type === 'element' && !BLOCK_LEVEL.has(parent.tagName)) return false;
  const siblings = laidOut(parent).filter((node) => node !== element);
  return allBlocks(laidOut(element)) || allBlocks(siblings);
}

function ruleOf(element: Element): string {
  return SAME_RENDERING[element.tagName] ?? element.tagName;
}

/**
 * Whether this occurrence draws anything a reader could tell apart from the
 * document without it. `inEffect` is the set of absolute rules the ancestors
 * have already applied.
 */
function contributes(element: Element, parent: Parent, inEffect: ReadonlySet<string>): boolean {
  if (rendersByAttribute(element)) return true;
  const tag = element.tagName;
  if (NO_RENDERING_BARE.has(tag)) return false;
  if (ROW_GROUPS.has(tag)) return false;
  const rule = ruleOf(element);
  if (IDEMPOTENT.has(rule) && inEffect.has(rule)) return false;
  if (DRAWS_NOTHING.has(tag) && joinsNothing(element, parent)) return false;
  return true;
}

export function renderedCensusOfHtml(html: string): RenderedCensus {
  return renderedCensusOf(unified().use(rehypeParse, { fragment: true }).parse(html));
}

export function renderedCensusOf(tree: HastNodes): RenderedCensus {
  const rules = new Map<string, Map<string, number>>();

  const walk = (parent: Parent, inEffect: ReadonlySet<string>): void => {
    for (const child of parent.children) {
      if (child.type !== 'element') continue;
      const rule = ruleOf(child);
      if (contributes(child, parent, inEffect)) {
        const tags = rules.get(rule) ?? new Map<string, number>();
        tags.set(child.tagName, (tags.get(child.tagName) ?? 0) + 1);
        rules.set(rule, tags);
      }
      const sets = IDEMPOTENT.has(rule) ? rule : ALSO_SETS[child.tagName];
      walk(child, sets === undefined ? inEffect : new Set([...inEffect, sets]));
    }
  };

  if (tree.type === 'root' || tree.type === 'element') walk(tree, new Set());
  return { rules };
}

const total = (tags: ReadonlyMap<string, number> | undefined): number =>
  [...(tags ?? new Map<string, number>()).values()].reduce((sum, count) => sum + count, 0);

/**
 * The tags whose rule the second document draws fewer times than the first,
 * then the ones it draws more times - the shape `compareCensus` returns, so a
 * note can name them the same way.
 *
 * A rule that went from three to two is reported under whichever tags the
 * first document had more of: a document that had `<b>`, `<b>` and `<strong>`
 * and now has two `<strong>` lost a `<b>`, in the only sense that means
 * anything to its reader - one bold run fewer.
 */
export function compareRendered(
  first: RenderedCensus,
  second: RenderedCensus,
): readonly MarkupChange[] {
  const changes: MarkupChange[] = [];
  const named = (
    from: ReadonlyMap<string, number>,
    against: ReadonlyMap<string, number> | undefined,
  ): string[] => {
    const more = [...from].filter(([tag, count]) => count > (against?.get(tag) ?? 0));
    return (more.length > 0 ? more : [...from]).map(([tag]) => tag);
  };

  for (const [rule, tags] of first.rules) {
    const after = second.rules.get(rule);
    if (total(after) < total(tags)) {
      for (const name of named(tags, after)) changes.push({ kind: 'element-dropped', name });
    }
  }
  for (const [rule, tags] of second.rules) {
    const before = first.rules.get(rule);
    if (total(before) < total(tags)) {
      for (const name of named(tags, before)) changes.push({ kind: 'element-added', name });
    }
  }

  return changes;
}
