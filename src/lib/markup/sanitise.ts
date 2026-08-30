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
 * EVERYTHING BELOW IS A NARROWING of `defaultSchema` - GitHub's own schema,
 * the one that renders every README. Nothing here adds a tag, an attribute or
 * a protocol, and that is a rule rather than a coincidence: an allow-list is
 * only worth having if changes to it are subtractions.
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

  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => !NEVER.includes(tag)),

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

  /* Comments can carry conditional-comment payloads in older engines. */
  allowComments: false,

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
