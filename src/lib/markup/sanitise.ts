import { defaultSchema } from 'rehype-sanitize';

import type { Options as SanitiseSchema } from 'rehype-sanitize';

/**
 * THE SANITISER.
 *
 * `rehype-sanitize` (hast-util-sanitize), and the choice is not incidental.
 *
 * DOMPurify is the better-known answer and it is a good sanitiser, but it is
 * DOM-only: it needs a real `document`, which a Web Worker does not have. Same
 * for Turndown, which ships its own DOM implementation to get one. These tools
 * accept megabytes of markup, so they run in the worker, which means the
 * sanitiser has to be pure JavaScript over a syntax tree rather than over a
 * live document.
 *
 * That constraint turns out to be an advantage. hast-util-sanitize is an
 * ALLOW-LIST applied to an ALREADY-PARSED tree. It never sees a string of HTML
 * and never has to decide what a malformed tag "means" - the parse has already
 * happened, once, and cannot be made to happen differently the second time.
 * That is what closes the mutation-XSS family by construction rather than by
 * pattern-matching: there is no second parse to disagree with the first.
 *
 * ALMOST EVERYTHING BELOW IS A NARROWING of `defaultSchema` - GitHub's own
 * schema, the one that renders every README. The rule was once "changes to an
 * allow-list are subtractions", and it is a good rule, but it was being used
 * to avoid an analysis rather than to conclude one. `ALSO_ALLOWED` below is
 * the analysis, done element by element; everything else here still only
 * takes things away.
 */

/**
 * Elements this app refuses even if the default schema ever allows them.
 *
 * The default currently allows none of these, so today this filter is a no-op.
 * It exists so that a future version of the dependency that starts permitting
 * `<video>` or `<svg>` does not silently permit it here too. A security
 * boundary that depends on a dependency's defaults not changing is not a
 * boundary.
 */
const NEVER: readonly string[] = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'form',
  'button',
  'select',
  'textarea',
  'noscript',
  'template',
  'base',
  'link',
  'meta',
  'svg',
  'math',
  'audio',
  'video',
  'source',
  'track',
  'canvas',
  'portal',
];

/**
 * `<input>` is NOT in that list, deliberately.
 *
 * GFM task lists render as `<input type="checkbox" disabled>`, so removing the
 * element removes the feature - the checkboxes vanish and `- [x] done` comes
 * back from a round trip as `- done`. The default schema handles this exactly
 * right and safer than a blanket ban would: `input` may carry only `type` and
 * `disabled`, and its `required` rule FORCES `type="checkbox"` and
 * `disabled=true` onto any input that survives. An `<input type="image"
 * src=x>` is rewritten into an inert checkbox rather than dropped, which is
 * the same outcome by a more robust route.
 */

/**
 * EIGHT ELEMENTS ADDED BACK, each analysed rather than waved through.
 *
 * These are content-bearing: dropping them does not remove decoration, it
 * removes meaning. `<abbr title="HyperText Markup Language">HTML</abbr>` loses
 * the expansion entirely; a `<figure>` loses the association between a picture
 * and its caption; `<mark>` loses the fact that somebody highlighted this
 * exact phrase. And because the sanitiser is the outer boundary, the
 * `unsupported: 'keep'` option could never preserve them either - they were
 * gone before it was consulted.
 *
 * THE ATTRIBUTE ANALYSIS, which is the part that was missing before. Not one
 * of these needs an attribute added: `title`, `dateTime` and `align` are
 * already in the schema's wildcard list, and that list contains no event
 * handler and no fetchable URL. So this is a change to the TAG list only, and
 * the attribute surface is exactly what it was.
 *
 * Element by element:
 *
 *   abbr        `title` carries the expansion. A string shown as a tooltip;
 *               it is not a URL and cannot be navigated to.
 *   figure      No attributes of its own. A grouping box.
 *   figcaption  No attributes of its own. Its caption.
 *   caption     A table's caption. Must stay a child of <table>, which the
 *               HTML parser enforces before this schema is consulted.
 *   mark        No attributes. Highlight.
 *   cite        The ELEMENT (a work's title), not the `cite` ATTRIBUTE on
 *               blockquote and q - that one is a URL and is already governed
 *               by the protocol list below.
 *   time        `dateTime` is a machine-readable timestamp string with a
 *               grammar of its own. Not a URL, not executable.
 *   small       No attributes. De-emphasis.
 *
 * None opens a browsing context, none loads a subresource, none has content
 * that is script or style. They are inert.
 */
const ALSO_ALLOWED: readonly string[] = [
  'abbr',
  'figure',
  'figcaption',
  'caption',
  'mark',
  'cite',
  'time',
  'small',
];

/**
 * URL schemes permitted in href/src, narrowed from the default.
 *
 * Dropped: `irc`, `ircs`, `xmpp`, which the default allows and no converted
 * prose needs. Never present in the default and never added here: `javascript:`
 * and `data:`. `data:` matters as much as `javascript:` and is easier to
 * forget - a `data:text/html` href navigates to an attacker-authored document,
 * and `data:image/svg+xml` can carry script.
 *
 * `mailto` and `tel` are kept because they cannot execute or fetch anything;
 * they hand off to an external handler. Dropping them would silently turn a
 * contact link into plain text on every conversion.
 */
const PROTOCOLS: readonly string[] = ['http', 'https', 'mailto', 'tel'];

/**
 * `data:` WAS CONSIDERED FOR `src`, AND REFUSED.
 *
 * The argument for it is real: HTML copied from a rendered page carries its
 * images as data URLs, and every one of them arrives here as nothing. And an
 * SVG loaded through `<img src>` is in secure static mode, where script does
 * not run - so `data:image/svg+xml,<svg onload=alert(1)>` is inert in the one
 * element that could still have a `src` once script, iframe, object, embed,
 * video and audio are banned.
 *
 * It is refused anyway, on the ground that this tool's output is HTML somebody
 * PASTES SOMEWHERE ELSE. "Inert in an `<img>`" is a fact about one element in
 * one context; the payload would be sitting in the user's document, one
 * transformation away from a context where it is not inert. The allow-list is
 * worth more than the images are.
 *
 * What was fixed instead is the symptom that prompted this: an image whose
 * source is rejected no longer renders as a broken icon. See
 * `replaceDeadImages` in pipelines.ts - it becomes its alt text, which is what
 * the alt text is for.

/**
 * Elements removed WITH their children rather than unwrapped.
 *
 * This distinction is the one that catches people out. hast-util-sanitize's
 * default for a disallowed element is to keep its children - which is right
 * for `<font>`, and wrong for `<script>`: unwrapping it would delete the tag
 * and leave `alert(1)` sitting in the document as visible text, or worse, as
 * text that something downstream re-parses. Anything whose content is code,
 * styling or a nested browsing context goes here.
 */
const STRIP: readonly string[] = [
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'form',
  'noscript',
  'template',
  'svg',
  'math',
];

export const SANITISE_SCHEMA: SanitiseSchema = {
  ...defaultSchema,

  tagNames: [
    ...(defaultSchema.tagNames ?? []).filter((tag) => !NEVER.includes(tag)),
    ...ALSO_ALLOWED,
  ],

  /*
   * The attribute allow-list is the default's, untouched.
   *
   * Its wildcard entry is a list of 60-odd presentational and ARIA attribute
   * names, and there is not an event handler among them. That is what removes
   * `onerror`, `onload`, `onmouseover` and every handler anyone invents later
   * as a CLASS rather than by name - the mechanism is that they were never
   * allowed, not that they were spotted and deleted.
   *
   * Note what is NOT in the wildcard: `className`. Classes are allowed only on
   * the specific elements that need them (`li`, `ol`, `code`, `div`, `span`)
   * and, on `li` and `ol`, only the exact task-list values. Adding className to
   * the wildcard to be helpful would widen the boundary, which is why this
   * object is inherited rather than rewritten.
   */
  attributes: defaultSchema.attributes,

  protocols: {
    href: [...PROTOCOLS],
    src: [...PROTOCOLS],
    cite: [...PROTOCOLS],
    longDesc: [...PROTOCOLS],
  },

  strip: [...STRIP],

  /*
   * CLOBBERING IS TURNED OFF HERE AND DONE OURSELVES. See namespaceIds() in
   * pipelines.ts.
   *
   * The protection itself is worth having: an element with `id="location"`
   * can shadow a global wherever the output is pasted, so author-supplied
   * identifiers belong in their own namespace. What the built-in version
   * cannot do is apply that namespace TWICE without changing the answer - it
   * prefixes whatever id it finds, including one that already carries the
   * prefix.
   *
   * Found by the semantic-stability property test: `user-content-fn-1` became
   * `user-content-user-content-fn-1` on the next pass and grew again on every
   * one after, so converting the same document twice produced different HTML.
   * It also never touched `href`, so every in-document anchor pointed at an id
   * that no longer existed under that name.
   */
  clobber: [],

  /*
   * COMMENTS ARE KEPT, which reverses an earlier default.
   *
   * They were dropped on the grounds that a comment can carry a
   * conditional-comment payload. That risk is real but historical - it needs
   * IE 9 or older to execute - and a comment is inert in every engine this
   * project supports. Against that, `<!-- prettier-ignore -->`,
   * `<!-- more -->` and `<!-- TOC -->` are load-bearing in real documents, and
   * silently deleting something the author wrote is the failure this tool
   * exists to avoid.
   *
   * There is no mutation-XSS angle here of the kind that usually makes
   * comments interesting: this sanitiser works on an ALREADY-PARSED tree, so
   * there is no second parse for a comment to confuse, and the foreign-content
   * contexts where comments can break out - `<svg>` and `<math>` - are refused
   * outright by NEVER above.
   *
   * The exceptions are removed by `dropMachineComments` in pipelines.ts:
   * conditional comments and Word's fragment markers, which are somebody
   * else's plumbing rather than anybody's content.
   */
  allowComments: true,

  /* A doctype is not content and has no business inside a fragment. */
  allowDoctypes: false,
};

/**
 * Where the sanitiser sits, and why it is in both pipelines.
 *
 * Doing only one side is the common mistake:
 *
 *   - ON THE WAY IN, because pasted HTML is untrusted and is about to be
 *     walked, transformed and re-serialised. Anything hostile that survives
 *     into the tree comes back out in the Markdown.
 *   - ON THE WAY OUT, because Markdown may contain raw HTML blocks. `<script>`
 *     written inside a Markdown document is still `<script>` once rendered,
 *     and the entire point of that output is that somebody may render or paste
 *     it somewhere that does.
 */
export const SANITISE_NOTE =
  'HTML is sanitised on the way in and on the way out, by an allow-list applied to the parsed tree.';
