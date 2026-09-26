import {
  compareCensus,
  censusOfHtml,
  deadFragments,
  droppedIdentifiers,
  lostClassNames,
  renamedIdentifiers,
  type Census,
  type LostClassName,
  type MarkupChange,
} from '@/lib/markup/changes';
import { compareRendered, renderedCensusOfHtml } from '@/lib/markup/rendering';
import { lost, noted, type ToolNote } from '@/lib/notes';
import { plural } from '@/lib/plural';
import { someOf } from '@/lib/someOf';

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
  /**
   * The element names the sanitiser permits, passed in for the same reason as
   * `idNamespace`: the schema lives beside the pipelines, and a static import
   * would pull the markup library into the graph the dynamic import keeps it
   * out of. The element note's sentence is "is not on the allowed list", and
   * this is what makes that sentence checked rather than assumed.
   */
  readonly allowedElements: ReadonlySet<string>;
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
 *   HUB_AND_OUTPUT  a loss the hub already has - the allow-list dropping raw HTML on
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

/**
 * `btn on <a>, primary on <a>, <div>`, capped with a count - the same bargain
 * every by-name list in this file strikes.
 */
function classList(classes: readonly LostClassName[]): string {
  return someOf(
    classes.map(
      ({ name, elements }) => `${name} on ${elements.map((tag) => `<${tag}>`).join(', ')}`,
    ),
    '; ',
  );
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

  /*
   * THE CENSUS THE MARKDOWN TARGET NEVER HAD.
   *
   * `markdown` is in this branch now, and the reasoning below - "for Markdown
   * there is nothing to compare" - is why it was not. That reasoning is sound
   * for a Markdown SOURCE and does not hold for an HTML one: here there are
   * three documents, exactly as there are for an HTML target. The third is the
   * output rendered back to HTML, which index.ts was already computing for the
   * `rendered` port and which is the same string the `html` target calls
   * `normalised`. So TC-5's `<caption>`, TC-1's flattened cell and TC-13's
   * invented header row are reported by the instrument that was already there,
   * at no extra conversion.
   *
   * `text` STAYS OUT, and that is the boundary rather than an omission. Plain
   * text has no markup in it, so there is no third document to take a census
   * of - which is the same absence the Markdown SOURCE has, and the one place
   * the comment above still applies.
   */
  if (input.source === 'html' && input.target !== 'text') {
    return [...identifiers, ...htmlNotes(input)];
  }
  if (input.source === 'markdown' && input.target === 'markdown') {
    const removed = markdownToHtmlNotes(input);
    return [...removed, ...markdownNotes(input, removed.length > 0)];
  }
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
 * Applies to every target a Markdown source has, plain text AND Markdown
 * included: a thing the allow-list removed before the text was extracted is
 * still a thing the document had, and the text output is where its absence is
 * least visible. Until round seventeen this comment said so and the Markdown
 * target was the exception - `<foo>bar</foo>` came back as `bar` under a note
 * saying the meaning was unchanged.
 *
 * A LINK OR AN IMAGE WHOSE ADDRESS WAS REFUSED is not raw HTML and is not an
 * element the list refuses, so it gets the same sentences the HTML source
 * gives it (`refusedAddressNotes`) rather than being blamed on markup the
 * document may not have. `[x](javascript:alert(1))` used to become `x` with no
 * note at all, and `<irc://host>` was told its `<a>` was not on the list.
 */
function markdownToHtmlNotes(input: NormalisationInput): readonly ToolNote[] {
  if (input.unsanitised === null) return [];

  const sanitised = censusOfHtml(input.sanitised);
  const changes = compareCensus(input.unsanitised, sanitised);
  const deadLinks = input.unsanitised.linksWithAddress - sanitised.linksWithAddress;
  const deadImages = input.unsanitised.imagesWithSource - sanitised.imagesWithSource;
  const elements = named(
    changes.filter((change) => !input.allowedElements.has(change.name)),
    'element-dropped',
  );
  const attributes = named(changes, 'attribute-dropped').filter(
    (name) =>
      !(name === 'href' && deadLinks > 0) &&
      !((name === 'src' || name === 'alt') && deadImages > 0),
  );

  const notes: ToolNote[] = [];
  if (elements.length > 0 || attributes.length > 0) {
    const parts = [
      ...(elements.length > 0 ? [elements.join(', ')] : []),
      ...(attributes.length > 0 ? [attributes.join(', ')] : []),
    ];
    notes.push(
      lost(
        `${(elements.length + attributes.length).toString()} ${plural(elements.length + attributes.length, 'thing the allow-list does not permit was removed', 'things the allow-list does not permit were removed')}`,
        `Markdown can contain raw HTML and this document does. ${parts.join(' and ')} ${plural(elements.length + attributes.length, 'is', 'are')} not on the allow-list, so ${plural(elements.length + attributes.length, 'it was', 'they were')} removed on the way out. That list is what makes this output safe to paste into a page.`,
        // The allow-list runs on the way INTO the hub, so both documents are
        // missing what it removed.
        HUB_AND_OUTPUT,
      ),
    );
  }
  return [...notes, ...refusedAddressNotes(deadLinks, deadImages)];
}

/**
 * What happened to a link or an image whose address the allowed list refused,
 * from either source: the sanitiser removes the attribute, and two steps after
 * it take the element too.
 */
function refusedAddressNotes(deadLinks: number, deadImages: number): readonly ToolNote[] {
  const addresses =
    'which keeps http, https, mailto and tel addresses and relative ones and refuses every other scheme - javascript:, data: and blob: among them';
  const notes: ToolNote[] = [];
  if (deadLinks > 0) {
    notes.push(
      lost(
        `${deadLinks.toString()} ${plural(deadLinks, 'link became', 'links became')} plain text`,
        `The address of ${plural(deadLinks, 'a link', 'each')} was refused by the allowed list, ${addresses}. A link with no address goes nowhere, so its words are kept and the link is not.`,
        HUB_AND_OUTPUT,
      ),
    );
  }
  if (deadImages > 0) {
    notes.push(
      lost(
        `${deadImages.toString()} ${plural(deadImages, 'image was', 'images were')} replaced by ${plural(deadImages, 'its', 'their')} alt text`,
        `The source of ${plural(deadImages, 'an image', 'each')} was refused by the allowed list, ${addresses}. An image with no source could only draw a broken-image icon, so an image with alt text becomes that text and one without is removed.`,
        HUB_AND_OUTPUT,
      ),
    );
  }
  return notes;
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
  const listed = (names: readonly string[], describe: (name: string) => string): string =>
    someOf(names.map(describe));

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
  const inputCensus = censusOfHtml(input.input);
  const sanitisedCensus = censusOfHtml(input.sanitised);
  const bySanitiser = compareCensus(inputCensus, sanitisedCensus);

  /*
   * A LINK AND AN IMAGE THE LIST REFUSED, WHICH ARE NOT THE ELEMENTS IT REFUSED.
   *
   * `<a>` and `<img>` are on the allowed list. When their ADDRESS is not, the
   * sanitiser removes the attribute and two steps after it take the element
   * too - a link to nowhere becomes its words, an image with no source becomes
   * its alt text - and the name census saw an `<a>` go and said the element
   * "is not on the allowed list". It is. Found by the pasted-HTML corpus
   * (`refused-link`, `refused-image`), with the same wrong reason given for
   * the Google Docs `<b>` that `unwrapFakeBold` removes before the sanitiser
   * runs, which nothing needs to be told about: that `<b>` asked not to be bold.
   *
   * So the element note names only what the list really refuses, which is
   * what its sentence says, and the two elements that go for their address
   * say that instead. The attribute note leaves out an `href`, `src` or `alt`
   * these two already account for: the same loss twice is a list nobody reads.
   */
  const deadLinks = inputCensus.linksWithAddress - sanitisedCensus.linksWithAddress;
  const deadImages = inputCensus.imagesWithSource - sanitisedCensus.imagesWithSource;
  const sanitisedAttributes = named(bySanitiser, 'attribute-dropped').filter(
    (name) =>
      !(name === 'href' && deadLinks > 0) &&
      !((name === 'src' || name === 'alt') && deadImages > 0),
  );
  const sanitisedElements = named(
    bySanitiser.filter((change) => !input.allowedElements.has(change.name)),
    'element-dropped',
  );
  if (sanitisedAttributes.length > 0) {
    notes.push(
      lost(
        `${sanitisedAttributes.length.toString()} ${plural(sanitisedAttributes.length, 'attribute was', 'attributes were')} removed by the sanitiser`,
        `${sanitisedAttributes.join(', ')} ${plural(sanitisedAttributes.length, 'is', 'are')} not on the allowed list, so ${plural(sanitisedAttributes.length, 'it is', 'they are')} removed from every document this tool produces. That list is what stops an event handler or a javascript: URL surviving a paste, and it is deliberately narrow - styling hooks go with it.`,
        // The sanitiser IS the hub, so `rendered` lost it too.
        HUB_AND_OUTPUT,
      ),
    );
  }

  if (sanitisedElements.length > 0) {
    notes.push(
      lost(
        `${sanitisedElements.length.toString()} ${plural(sanitisedElements.length, 'element was', 'elements were')} removed by the sanitiser`,
        `${sanitisedElements.join(', ')} ${plural(sanitisedElements.length, 'is', 'are')} not on the allowed list. Scripts, styles and embedded frames are removed outright rather than escaped, because what this tool produces is meant to be safe to paste into a page.`,
        HUB_AND_OUTPUT,
      ),
    );
  }

  notes.push(...refusedAddressNotes(deadLinks, deadImages));

  /*
   * CORPUS ROW 16: A CLASS NAME THE SANITISER TOOK OUT OF AN ATTRIBUTE IT KEPT.
   *
   * `<a class="btn">` comes out `<a class="">`, because the schema allows
   * `class` on `<a>` for one value only and filters rather than removes. The
   * name census sees `class` on both sides and said nothing for eight rounds.
   *
   * Only when `class` is NOT already named above: an attribute gone from every
   * element is the note before this one, and the same loss twice is a list
   * nobody reads.
   */
  if (!sanitisedAttributes.includes('class')) {
    const classes = lostClassNames(inputCensus, sanitisedCensus);
    if (classes.length > 0) {
      notes.push(
        lost(
          `${classes.length.toString()} ${plural(classes.length, 'class name was', 'class names were')} removed by the sanitiser`,
          `${classList(classes)} went in and did not come out. The allowed list keeps class only where this tool has a use for it - a task list's own markers, a code block's language, a footnote's back-link - and takes every other name out. Where an element may carry a class at all the attribute stays behind holding only the permitted names, which is why a link written class="btn" comes out class="".`,
          HUB_AND_OUTPUT,
        ),
      );
    }
  }

  /*
   * AND THE ROUND TRIP'S, which two targets have. This is the half that
   * INVENTS, and inventing is the part nothing reported at all.
   *
   * `normalised` is the document the trip produced. For the `html` target that
   * IS the output; for the `markdown` target it is the output rendered back to
   * HTML, because an element is only countable as an element there. The
   * sentences say which, since a reader holding Markdown is not holding the
   * document these three notes were measured on.
   */
  if (input.normalised === null) return notes;

  const measured =
    input.target === 'markdown'
      ? ' Measured by rendering this Markdown back to HTML, which is the only form an element can be counted in.'
      : '';
  const trip =
    input.target === 'markdown'
      ? 'Converting to Markdown bounds the document by what Markdown can express, and'
      : 'Normalising takes the document out to Markdown and back, and';

  /*
   * THE HEADER-ROW SENTENCE, ONLY WHEN IT IS ABOUT THIS DOCUMENT.
   *
   * It used to be appended to every invention, and extending the census to the
   * Markdown target is what made that a false sentence rather than an
   * irrelevant one: a `<mark>` becoming `_…_` invented an `<em>` (until round
   * thirteen stopped the substitution), and the note explained it by saying a
   * Markdown table always has a header row. The count was right and the reason
   * underneath it was about a different document.
   *
   * Asked of `<tr>` and `<th>`, which is what an invented header row IS - the
   * `<thead>` around it draws nothing and is not counted (`rendering.ts`).
   */
  const tableRow = (elements: readonly string[]): string =>
    elements.includes('<tr>') || elements.includes('<th>')
      ? ' A Markdown table always has a header row, so a <table> written without one gains an empty header row that nobody wrote.'
      : '';

  /*
   * TC-3: A REVERSED LIST'S NUMBERS, WHICH ARE CONTENT RATHER THAN A NAME.
   *
   * `reversed` survives the sanitiser from round thirteen, so what goes is the
   * round trip's doing, and the attribute note names it. What the name alone
   * does not say is the consequence a reader sees: `<ol reversed>` displays
   * 3, 2, 1, and CommonMark numbers a list upward from its first item whatever
   * digits are written, so no Markdown spelling of those items counts down.
   */
  const reversedList = (attributes: readonly string[]): string =>
    attributes.includes('reversed')
      ? ' A list marked reversed counted down; a Markdown list always counts up from its first number, so the same items, in the same order, now count up.'
      : '';

  /*
   * ATTRIBUTES BY NAME, ELEMENTS BY WHAT THEY DRAW.
   *
   * An attribute's name is the thing a reader loses - a stylesheet hook, a
   * language, a title - so the name census answers the attribute question.
   * An element's name is not: `<b>` and `<strong>` draw the same bold, a bare
   * `<span>` draws nothing, and a census of names said all three were losses
   * or inventions. The elements are compared by `rendering.ts`, which counts
   * what the HTML Standard's stylesheet makes of each one where it stands,
   * and is held to three engines' pixels by the pasted-HTML corpus.
   */
  const normalisedCensus = censusOfHtml(input.normalised);
  const byRoundTrip = compareCensus(sanitisedCensus, normalisedCensus);
  const drawn = compareRendered(
    renderedCensusOfHtml(input.sanitised),
    renderedCensusOfHtml(input.normalised),
  );
  const droppedAttributes = named(byRoundTrip, 'attribute-dropped');
  const droppedElements = named(drawn, 'element-dropped');
  const addedElements = named(drawn, 'element-added');

  /*
   * AN INVENTED PARAGRAPH IS SAID, AND SAID AT THE STRENGTH IT HAS.
   *
   * Markdown holds text in paragraphs, so text that was loose - directly in
   * the document, in a `<div>` that draws nothing, in a list term - comes back
   * inside a `<p>`, and a `<p>` has a line of space above and below it. Whether
   * that space SHOWS depends on its neighbours: measured, it is invisible
   * after a heading at the end of a document, sixteen pixels in front of a
   * `<div>` and eight at the top of one, in all three engines. A census
   * cannot see the neighbours (see `rendering.ts`), so the claim it can
   * support is the weaker one - the paragraph is there, and it
   * may move things - and that is an `info`, not a loss on the node's face.
   * The other inventions stay warnings: a header row, a link a bare URL grew,
   * are things a reader sees wherever they are.
   */
  const paragraphs = addedElements.includes('<p>');
  const added = addedElements.filter((name) => name !== '<p>');

  if (droppedAttributes.length > 0) {
    notes.push(
      lost(
        `${droppedAttributes.length.toString()} ${plural(droppedAttributes.length, 'attribute the round trip could not carry', 'attributes the round trip could not carry')}`,
        `${trip} Markdown has no spelling for ${droppedAttributes.join(', ')}.${reversedList(droppedAttributes)}${measured} Choose HTML (sanitised) to keep ${plural(droppedAttributes.length, 'it', 'them')}: it runs the sanitiser and nothing else.`,
        // The round trip happens AFTER the hub, so `rendered` still has it.
        afterHub(input),
      ),
    );
  }

  // The class-name half of the same question, for the round trip. Same rule
  // as the sanitiser's: silent when `class` itself is already named above.
  if (!droppedAttributes.includes('class')) {
    const classes = lostClassNames(sanitisedCensus, normalisedCensus);
    if (classes.length > 0) {
      notes.push(
        lost(
          `${classes.length.toString()} ${plural(classes.length, 'class name', 'class names')} the round trip could not carry`,
          `${trip} Markdown keeps a class only where it has a construct that implies one - a fenced block's language, a task list. ${classList(classes)} went in and did not come out.${measured} Choose HTML (sanitised) to keep ${plural(classes.length, 'it', 'them')}.`,
          afterHub(input),
        ),
      );
    }
  }

  if (droppedElements.length > 0) {
    notes.push(
      lost(
        `${droppedElements.length.toString()} ${plural(droppedElements.length, 'element the round trip could not carry', 'elements the round trip could not carry')}`,
        `Markdown has no spelling for ${droppedElements.join(', ')}, so ${plural(droppedElements.length, 'it was', 'they were')} unwrapped or dropped.${measured} Choose HTML (sanitised) to keep the markup as it is, or set "Markup Markdown cannot express" to Keep as inline HTML for the elements that option covers.`,
        afterHub(input),
      ),
    );
  }

  if (added.length > 0) {
    notes.push(
      lost(
        `${added.length.toString()} ${plural(added.length, 'element was', 'elements were')} invented by the round trip`,
        `${added.join(', ')} ${plural(added.length, 'is', 'are')} in the result and ${plural(added.length, 'was', 'were')} not in the input.${tableRow(added)}${measured} Choose HTML (sanitised) for a pass that invents nothing.`,
        afterHub(input),
      ),
    );
  }

  if (paragraphs) {
    notes.push(
      noted(
        'Loose content was put in a paragraph',
        `Something in the input that was not inside a paragraph - text or an image directly in the document, in a <div>, in a list term - is inside a <p> now, because a paragraph is the only way Markdown can hold it. A paragraph has a line of space above and below it, which shows wherever its neighbours do not already have as much.${measured}`,
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

function markdownNotes(input: NormalisationInput, somethingRemoved: boolean): readonly ToolNote[] {
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
      `Markdown to Markdown goes out to HTML and back, so the output is written in this tool’s own style: the bullet, emphasis, fence and heading options above decide how. ${somethingRemoved ? 'Apart from what the note above names, the meaning is unchanged' : 'The meaning is unchanged'} - "md to html to md to html" is asserted stable - but the bytes are not the ones that went in.`,
    ),
  );

  return notes;
}
