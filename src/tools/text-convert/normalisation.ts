import {
  compareCensus,
  compareMarkup,
  censusOfHtml,
  type Census,
  type MarkupChange,
} from '@/lib/markup/changes';
import { lost, noted, type ToolNote } from '@/lib/notes';

import type { SourceFormat, TargetFormat } from './detect';

/**
 * WHAT A CONVERSION CHANGED, AND WHAT IT INVENTED.
 *
 * Two of this tool's source-and-target combinations are round trips through
 * another format, and both were `lossy, silent` in docs/conversion-matrix.md.
 *
 * WHAT THE MEASUREMENT FOUND, which is not what the matrix said. Writing the
 * instrument first and reading the answers off it moved three claims:
 *
 *   - `class` and `data-*` are dropped by the SANITISER, in both HTML targets,
 *     not by the Markdown round trip. The matrix listed them under the round
 *     trip. So the sanitising half needs a report of its own; "sanitise only"
 *     is not "lose nothing".
 *   - A footnote does not become `<sup>` markup. It becomes an ordinary link to
 *     an anchor plus a `## Footnotes` section.
 *   - `$$…$$` display maths does not become an inline code span. It becomes a
 *     fenced block tagged `math`.
 *
 * TWO DIFFERENT INSTRUMENTS, because the two questions are different.
 *
 * For HTML the documents can be compared directly, and they are compared TWICE
 * so that each half of the pass answers for itself: input against sanitised is
 * what the sanitiser did, sanitised against normalised is what the round trip
 * did. That is much better than a written-down list of transformations, because
 * it keeps reporting the truth when the pipeline changes - and it is how the
 * three corrections above were found.
 *
 * For Markdown there is nothing to compare: the loss is a CONSTRUCT with no
 * Markdown spelling on the way back, and by the time the output exists it has
 * already become something else. So the source is searched for the constructs
 * known not to survive, each named, and the round trip confirms it by being
 * different. Both halves are required.
 *
 * REFORMATTING IS NOT A LOSS, and is deliberately `info`. A different bullet
 * marker, a different heading style, an escaped character: the document means
 * the same thing, which the `md → html → md → html` stability property asserts.
 * Only the named constructs are `warn`, because `warn` is what a node prints on
 * its own face and a note that fires on every Markdown-to-Markdown run is one
 * nobody reads on the day it matters.
 */

export interface NormalisationInput {
  readonly source: SourceFormat;
  readonly target: TargetFormat;
  readonly input: string;
  readonly output: string;
  /** The hub value: the source parsed and sanitised, with no round trip. */
  readonly sanitised: string;
  /** The round trip's result, or null when this conversion made no round trip. */
  readonly normalised: string | null;
  /**
   * What the same Markdown CONTAINED before the allow-list saw it, for a
   * MARKDOWN source only, and only when the document has a `<` in it at all.
   *
   * A census - a set of tag and attribute names - rather than a document. There
   * is no unsanitised HTML string anywhere in this app and this is not the
   * place to invent one: a set of names has nothing in it to render, copy, put
   * on a port or accidentally return. See `markdownMarkupBeforeSanitising`.
   */
  readonly unsanitised: Census | null;
  readonly linkify: boolean;
}

/** An attribute's name as a sentence fragment: `data-*` rather than eleven of them. */
function attributeLabel(name: string): string {
  return name.startsWith('data-') ? 'data-*' : name;
}

function named(changes: readonly MarkupChange[], kind: MarkupChange['kind']): string[] {
  return [
    ...new Set(
      changes
        .filter((change) => change.kind === kind)
        .map((change) =>
          kind === 'attribute-dropped' ? attributeLabel(change.name) : `<${change.name}>`,
        ),
    ),
  ];
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function normalisationNotes(input: NormalisationInput): readonly ToolNote[] {
  if (input.source === 'html' && (input.target === 'html' || input.target === 'html-sanitised')) {
    return htmlNotes(input);
  }
  if (input.source === 'markdown' && input.target === 'markdown') return markdownNotes(input);
  if (input.source === 'markdown') return markdownToHtmlNotes(input);
  return [];
}

/**
 * THE RAW HTML A README CONTAINS, WHICH MARKDOWN → HTML DROPS.
 *
 * The matrix called this conversion "exact, 95.7%", and 95.7% is not what
 * exact means. Twenty-two of the twenty-eight CommonMark examples it does not
 * match are this: cmark copies raw HTML to the output verbatim and this tool
 * refuses to, because its output is meant to be safe to paste into a page.
 *
 * That refusal is the product. Being silent about it was not - an element the
 * list does not name, or an attribute it does not permit, went in and did not
 * come out and the result looked like a clean conversion. Measured against the
 * same chain with the allow-list off, so the note names what was REALLY removed
 * rather than a list somebody wrote by reading the schema. Measuring is also
 * what showed the schema to be more generous than its reputation: `<details>`,
 * `<summary>`, `<kbd>` and `<img align>` all survive.
 *
 * WHAT IT DOES NOT REPORT, ON PURPOSE. GFM’s tagfilter escapes `<script>`
 * and `<iframe>` into visible text before anything here sees them, so they are
 * not elements in either document and nothing is missing from the output. The
 * reader can see exactly what happened; a note would claim a removal that did
 * not occur.
 *
 * Applies to every target a Markdown source has, plain text included: a thing
 * the allow-list removed before the text was extracted is still a thing the
 * document had, and the text output is where its absence is least visible.
 */
function markdownToHtmlNotes(input: NormalisationInput): readonly ToolNote[] {
  if (input.unsanitised === null) return [];

  const changes = compareCensus(input.unsanitised, censusOfHtml(input.sanitised));
  const elements = named(changes, 'element-dropped');
  const attributes = named(changes, 'attribute-dropped');
  if (elements.length === 0 && attributes.length === 0) return [];

  const parts = [
    ...(elements.length > 0 ? [elements.join(', ')] : []),
    ...(attributes.length > 0 ? [attributes.join(', ')] : []),
  ];

  return [
    lost(
      `${(elements.length + attributes.length).toString()} ${plural(elements.length + attributes.length, 'thing the allow-list does not permit was removed', 'things the allow-list does not permit were removed')}`,
      `Markdown can contain raw HTML and this document does. ${parts.join(' and ')} ${plural(elements.length + attributes.length, 'is', 'are')} not on the allow-list, so ${plural(elements.length + attributes.length, 'it was', 'they were')} removed on the way out. That list is what makes this output safe to paste into a page; it is also why a README's <details> block does not survive.`,
    ),
  ];
}

function htmlNotes(input: NormalisationInput): readonly ToolNote[] {
  const notes: ToolNote[] = [];

  /*
   * THE SANITISER'S OWN LOSSES, which both HTML targets have.
   *
   * Measured rather than assumed, and the measurement is why this section
   * exists: `class` and `data-*` are removed HERE, not by the round trip, so
   * "HTML (sanitised)" loses them too. The note says why, because these are the
   * removals a person should be glad of.
   */
  const bySanitiser = compareMarkup(input.input, input.sanitised);
  const sanitisedAttributes = named(bySanitiser, 'attribute-dropped');
  const sanitisedElements = named(bySanitiser, 'element-dropped');

  if (sanitisedAttributes.length > 0) {
    notes.push(
      lost(
        `${sanitisedAttributes.length.toString()} ${plural(sanitisedAttributes.length, 'attribute was', 'attributes were')} removed by the sanitiser`,
        `${sanitisedAttributes.join(', ')} ${plural(sanitisedAttributes.length, 'is', 'are')} not on the allowed list, so ${plural(sanitisedAttributes.length, 'it is', 'they are')} removed from every HTML this tool produces. That list is what stops an event handler or a javascript: URL surviving a paste, and it is deliberately narrow - styling hooks go with it.`,
      ),
    );
  }

  if (sanitisedElements.length > 0) {
    notes.push(
      lost(
        `${sanitisedElements.length.toString()} ${plural(sanitisedElements.length, 'element was', 'elements were')} removed by the sanitiser`,
        `${sanitisedElements.join(', ')} ${plural(sanitisedElements.length, 'is', 'are')} not on the allowed list. Scripts, styles and embedded frames are removed outright rather than escaped, because an HTML output is something people paste into a page.`,
      ),
    );
  }

  /*
   * AND THE ROUND TRIP'S, which only the normalised target has. This is the
   * half that INVENTS, and inventing is the part nothing reported at all.
   */
  if (input.normalised === null) return notes;

  const byRoundTrip = compareMarkup(input.sanitised, input.normalised);
  const droppedAttributes = named(byRoundTrip, 'attribute-dropped');
  const droppedElements = named(byRoundTrip, 'element-dropped');
  const added = named(byRoundTrip, 'element-added');

  if (droppedAttributes.length > 0) {
    notes.push(
      lost(
        `${droppedAttributes.length.toString()} ${plural(droppedAttributes.length, 'attribute the round trip could not carry', 'attributes the round trip could not carry')}`,
        `Normalising takes the document out to Markdown and back, and Markdown has no spelling for ${droppedAttributes.join(', ')}. Choose HTML (sanitised) to keep ${plural(droppedAttributes.length, 'it', 'them')}: it runs the sanitiser and nothing else.`,
      ),
    );
  }

  if (droppedElements.length > 0) {
    notes.push(
      lost(
        `${droppedElements.length.toString()} ${plural(droppedElements.length, 'element the round trip could not carry', 'elements the round trip could not carry')}`,
        `Markdown has no spelling for ${droppedElements.join(', ')}, so ${plural(droppedElements.length, 'it was', 'they were')} unwrapped or dropped. Choose HTML (sanitised) to keep the markup as it is, or set "Markup Markdown cannot express" to Keep as inline HTML.`,
      ),
    );
  }

  if (added.length > 0) {
    notes.push(
      lost(
        `${added.length.toString()} ${plural(added.length, 'element was', 'elements were')} invented by the round trip`,
        `${added.join(', ')} ${plural(added.length, 'is', 'are')} in the output and was not in the input. A Markdown table always has a header row, so a <table> written without one gains an empty one on the way back. Choose HTML (sanitised) for a pass that invents nothing.`,
      ),
    );
  }

  return notes;
}

/** Constructs with no Markdown spelling on the way back, each named and measured. */
const MARKDOWN_CASUALTIES: readonly {
  readonly test: RegExp;
  readonly title: string;
  readonly body: string;
}[] = [
  {
    // A definition, not a reference: `[^1]` alone is ordinary text to remark.
    test: /^\s{0,3}\[\^[^\]\s]+\]:/m,
    title: 'Footnotes stopped being footnotes',
    body: 'GFM footnotes have no Markdown spelling on the way back from HTML. Each reference comes out as an ordinary link to an anchor and the definitions as a "Footnotes" heading with a list under it. The document reads the same and no longer has footnotes in it.',
  },
  {
    test: /\$\$[\s\S]*?\$\$/,
    title: 'Display maths became a fenced code block',
    body: 'A $$…$$ block is parsed as maths and written back as a fenced block tagged `math`, because that is the closest thing plain Markdown has. The formula is intact; the fact that it is a formula is carried by the fence’s language tag rather than by the syntax.',
  },
];

function markdownNotes(input: NormalisationInput): readonly ToolNote[] {
  // Nothing changed at all: the document was already in the shape this writer
  // produces. Saying anything here would be the note that cries wolf.
  if (input.input === input.output) return [];

  const notes: ToolNote[] = [];

  for (const casualty of MARKDOWN_CASUALTIES) {
    if (casualty.test.test(input.input)) notes.push(lost(casualty.title, casualty.body));
  }

  /*
   * A bare URL becoming an explicit link. Only claimed when `linkify` is on -
   * it is the extension that does it - and only when the input really has a
   * bare one and the output has an explicit one, so a document that already
   * wrote its links out is not accused of anything.
   */
  if (input.linkify) {
    const bare = /(^|[\s(])(https?:\/\/|www\.)[^\s)<>]+/;
    if (bare.test(input.input) && input.output.includes('](')) {
      notes.push(
        lost(
          'A bare URL became an explicit link',
          'GitHub turns a bare https:// or www. into a link, so the round trip writes it back as [url](url). Turn off "Link bare URLs" to leave it as text.',
        ),
      );
    }
  }

  notes.push(
    noted(
      'The document was reformatted',
      'Markdown to Markdown goes out to HTML and back, so the output is written in this tool’s own style: the bullet, emphasis, fence and heading options above decide how. The meaning is unchanged - "md to html to md to html" is asserted stable - but the bytes are not the ones that went in.',
    ),
  );

  return notes;
}
