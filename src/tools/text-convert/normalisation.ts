import {
  compareCensus,
  compareMarkup,
  censusOfHtml,
  deadFragments,
  droppedIdentifiers,
  renamedIdentifiers,
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
  /**
   * The `id` and `name` values a MARKDOWN source's own raw HTML declared, and
   * null for an HTML source, where the input is markup this module can parse.
   *
   * Supplied rather than derived because only the Markdown parser can tell an
   * identifier the author typed from the crowd this tool invents around it -
   * a heading slug, a footnote anchor - and those are not losses. See
   * `markdownAuthorIdentifiers`.
   */
  readonly markdownIdentifiers: ReadonlySet<string> | null;
  /**
   * The prefix the pipeline puts in front of author-supplied identifiers.
   *
   * Passed in rather than imported: `pipelines.ts` is loaded dynamically, on
   * purpose, and a static import of one constant from it would put the whole
   * markup library back in the module graph that the dynamic import exists to
   * keep it out of.
   */
  readonly idNamespace: string;
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

/**
 * WHICH OF THIS TOOL'S PORTS A LOSS IS ACTUALLY IN.
 *
 * `output` and `rendered` are not the same document, and treating them as one
 * would put a warning on the port that ESCAPED the loss - the thing
 * `ToolNote.reaches` exists to prevent.
 *
 * `rendered` is the SANITISED HUB for every target but Markdown, where index.ts
 * re-renders it from `output`. So:
 *
 *   atHub     a loss the hub already has - the allow-list dropping raw HTML on
 *             the way in, the sanitiser dropping an attribute. `output` is
 *             derived from the hub, so it is in both, always.
 *   afterHub  a loss the Markdown round trip caused, or one measured on
 *             `output` itself. In `rendered` only when the two really are the
 *             same document: a Markdown target, or an HTML target with no round
 *             trip to have come after.
 */
const HUB_AND_OUTPUT: readonly string[] = ['output', 'rendered'];

function afterHub(input: NormalisationInput): readonly string[] {
  const outputIsHub =
    input.target === 'html-sanitised' || (input.target === 'html' && input.normalised === null);
  return input.target === 'markdown' || outputIsHub ? HUB_AND_OUTPUT : ['output'];
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

export function normalisationNotes(input: NormalisationInput): readonly ToolNote[] {
  /*
   * Asked of the OUTPUT, and only where the output is HTML.
   *
   * A Markdown or plain-text target has no identifiers left in it to rename or
   * break, so naming one would describe a document the reader is not holding.
   * Where the output IS HTML the question is asked of it rather than of the
   * sanitised hub, because the two answer differently and the one the reader
   * has is the output - see `identifierNotes`.
   */
  const identifiers =
    input.target === 'html' || input.target === 'html-sanitised' ? identifierNotes(input) : [];

  if (input.source === 'html' && (input.target === 'html' || input.target === 'html-sanitised')) {
    return [...identifiers, ...htmlNotes(input)];
  }
  if (input.source === 'markdown' && input.target === 'markdown') return markdownNotes(input);
  if (input.source === 'markdown') return [...identifiers, ...markdownToHtmlNotes(input)];
  return identifiers;
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
      // The allow-list runs on the way INTO the hub, so both documents are
      // missing what it removed.
      HUB_AND_OUTPUT,
    ),
  ];
}

/**
 * AN IDENTIFIER THE AUTHOR WROTE, UNDER A PREFIX THEY DID NOT.
 *
 * `id="location"` goes in and `id="user-content-location"` comes out, of every
 * HTML this tool produces. It is deliberate and it is worth keeping - an id
 * can shadow a global wherever this output is pasted, and the built-in
 * clobbering it replaced was neither idempotent nor able to move an `href` -
 * but `compareMarkup` cannot see it, because `id` is present on both sides.
 * The matrix recorded that silence under "still unverified" and called the
 * behaviour "documented elsewhere". Elsewhere was a comment in this repository.
 *
 * `warn` RATHER THAN `info`, WHICH IS A CLOSER CALL THAN IT LOOKS. The byte
 * order mark next door is `info`: it is removed, the document still means the
 * same thing, and nothing outside the document was pointing at it. An
 * identifier is different in that last respect. Links INSIDE the document are
 * moved to match, so those still work - but a stylesheet, a script or another
 * page that referred to `#location` finds nothing, and finding nothing is
 * exactly the failure nobody reports. So it goes on the node's face.
 *
 * It fires only on a rename. A heading slug this tool INVENTED carries the
 * same prefix and is not a rename, which is what keeps this off every document
 * with a heading in it.
 *
 * AND WRITING IT FOUND A SECOND THING, WHICH IS WORSE THAN THE FIRST. Asking
 * the OUTPUT rather than the sanitised hub is what showed it: `HTML → HTML
 * (normalised)` takes the document out to Markdown, Markdown has no spelling
 * for a heading's id, and the id comes back as a slug of the heading's TEXT.
 * Measured, on `<h2 id="location">Where</h2>` with a link to `#location`: the
 * output is `<h2 id="user-content-where">` and the link still says
 * `#user-content-location`, which is now in no document anywhere. Both
 * documents contain one `id` and one `href`, so `compareMarkup` sees nothing at
 * all - a table of contents can be dead on arrival with every count equal.
 */
function identifierNotes(input: NormalisationInput): readonly ToolNote[] {
  const prefix = input.idNamespace;
  const declared = input.markdownIdentifiers ?? censusOfHtml(input.input).identifiers;
  if (declared.size === 0) return [];

  const after = censusOfHtml(input.output);
  const notes: ToolNote[] = [];

  // Capped with a count, the same bargain the by-path reports make: a document
  // with two hundred anchors would otherwise produce a list nobody reads.
  const listed = (names: readonly string[], describe: (name: string) => string): string => {
    const shown = names.slice(0, 5).map(describe).join(', ');
    const rest = names.length - Math.min(names.length, 5);
    return rest > 0 ? `${shown}, and ${rest.toString()} more` : shown;
  };

  const renamed = renamedIdentifiers(declared, after.identifiers, prefix);
  if (renamed.length > 0) {
    notes.push(
      lost(
        `${renamed.length.toString()} ${plural(renamed.length, 'identifier was', 'identifiers were')} namespaced`,
        `${listed(renamed, (name) => `${name} became ${prefix}${name}`)}. Every id and name this tool writes is prefixed ${prefix} so that markup pasted into a page cannot shadow something already there. Links inside the document are moved to match, so they still work; anything OUTSIDE it that pointed at the old name - a stylesheet, a script, a link from another page - will not find it.`,
        // Measured on `input.output`, so that is the port it is a fact about.
        afterHub(input),
      ),
    );
  }

  const dropped = droppedIdentifiers(declared, after, prefix);
  if (dropped.length > 0) {
    notes.push(
      lost(
        `${dropped.length.toString()} ${plural(dropped.length, 'identifier is', 'identifiers are')} not in the result`,
        `${listed(dropped, (name) => name)} went in and did not come out. Markdown has no spelling for an id, so normalising takes them out to Markdown and never brings them back - a heading gets a fresh id made from its own text instead. Choose HTML (sanitised) to keep the ones the document came with.`,
        afterHub(input),
      ),
    );
  }

  const dead = deadFragments(declared, after, prefix);
  if (dead.length > 0) {
    notes.push(
      lost(
        `${dead.length.toString()} ${plural(dead.length, 'link in the document points', 'links in the document point')} at nothing`,
        `${listed(dead, (name) => `#${name}`)} ${plural(dead.length, 'is', 'are')} in the output and ${plural(dead.length, 'names', 'name')} an id that is not. The link was working in the document that went in, and the id it named was renamed or dropped on the way through. Choose HTML (sanitised), which changes no document structure and moves every in-document link to match.`,
        afterHub(input),
      ),
    );
  }

  return notes;
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
        // The sanitiser IS the hub, so `rendered` lost it too.
        HUB_AND_OUTPUT,
      ),
    );
  }

  if (sanitisedElements.length > 0) {
    notes.push(
      lost(
        `${sanitisedElements.length.toString()} ${plural(sanitisedElements.length, 'element was', 'elements were')} removed by the sanitiser`,
        `${sanitisedElements.join(', ')} ${plural(sanitisedElements.length, 'is', 'are')} not on the allowed list. Scripts, styles and embedded frames are removed outright rather than escaped, because an HTML output is something people paste into a page.`,
        HUB_AND_OUTPUT,
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
        // The round trip happens AFTER the hub, so `rendered` still has it.
        afterHub(input),
      ),
    );
  }

  if (droppedElements.length > 0) {
    notes.push(
      lost(
        `${droppedElements.length.toString()} ${plural(droppedElements.length, 'element the round trip could not carry', 'elements the round trip could not carry')}`,
        `Markdown has no spelling for ${droppedElements.join(', ')}, so ${plural(droppedElements.length, 'it was', 'they were')} unwrapped or dropped. Choose HTML (sanitised) to keep the markup as it is, or set "Markup Markdown cannot express" to Keep as inline HTML.`,
        afterHub(input),
      ),
    );
  }

  if (added.length > 0) {
    notes.push(
      lost(
        `${added.length.toString()} ${plural(added.length, 'element was', 'elements were')} invented by the round trip`,
        `${added.join(', ')} ${plural(added.length, 'is', 'are')} in the output and was not in the input. A Markdown table always has a header row, so a <table> written without one gains an empty one on the way back. Choose HTML (sanitised) for a pass that invents nothing.`,
        afterHub(input),
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
    if (casualty.test.test(input.input))
      notes.push(lost(casualty.title, casualty.body, afterHub(input)));
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
          afterHub(input),
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
