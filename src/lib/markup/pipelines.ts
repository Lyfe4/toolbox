import { toHtml } from 'hast-util-to-html';
import { defaultHandlers } from 'hast-util-to-mdast';
import { toText } from 'hast-util-to-text';
import rehypeParse from 'rehype-parse';
import rehypeRaw from 'rehype-raw';
import rehypeRemark from 'rehype-remark';
import rehypeSanitize from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';

import { SANITISE_SCHEMA } from './sanitise';

import type { Element as HastElement, ElementContent, Nodes as HastNodes, RootContent } from 'hast';
import type { Handle, Options as ToMdastOptions, State } from 'hast-util-to-mdast';
import type { Root as MdastRoot, RootContent as MdastContent } from 'mdast';
import type { VFile } from 'vfile';

/**
 * THE CONVERSION PIPELINES.
 *
 * unified/remark/rehype rather than marked + turndown + DOMPurify, for one
 * decisive reason: everything here is pure JavaScript over a syntax tree, so
 * it runs in a Web Worker. Turndown ships a DOM implementation to get a
 * `document`; DOMPurify requires one. Neither exists in a worker, and these
 * tools accept megabytes of markup, so the worker is where they belong.
 *
 * The secondary reason is correctness: remark implements CommonMark and GFM
 * against their specifications and is the parser behind most of the Markdown
 * anyone has actually read. Hand-rolling any of this was never on the table.
 */

/**
 * Elements whose whitespace is content and must never be touched.
 *
 * A newline inside `<pre>` is a line of the program.
 */
const WHITESPACE_SENSITIVE = new Set(['pre', 'code', 'textarea', 'script', 'style']);

/**
 * Collapses runs of blank lines BETWEEN block elements.
 *
 * Needed because of `rehypeRaw`, and the reason is worth writing down. Raw mode
 * re-serialises the tree and re-parses it with a real HTML parser, and HTML
 * parsing does not permit text nodes inside `<table>` - so every newline that
 * remark put between `<thead>`, `<tr>` and `<td>` gets foster-parented out of
 * the table and concatenated in front of it. A one-row table produced twelve
 * consecutive newlines in the output. Measured: without rehypeRaw, zero.
 *
 * This walks the tree rather than running a regex over the finished string,
 * because a regex could not tell the newlines between two table rows from the
 * ones inside a fenced code block.
 */
function tidyWhitespace() {
  return (tree: HastNodes): void => {
    const walk = (node: HastNodes): void => {
      if (node.type !== 'root' && node.type !== 'element') return;
      if (node.type === 'element' && WHITESPACE_SENSITIVE.has(node.tagName)) return;

      for (const child of node.children) {
        if (child.type === 'text' && child.value.trim() === '' && child.value.includes('\n')) {
          child.value = '\n';
        } else {
          walk(child);
        }
      }
    };

    walk(tree);
  };
}

/**
 * GFM's "disallowed raw HTML" filter, and it fixes real content loss.
 *
 * These nine tags are the ones the GFM spec escapes rather than passes
 * through, and the reason is not squeamishness - it is that the HTML parser
 * treats them as RCDATA or RAWTEXT, so an unclosed one EATS THE REST OF THE
 * DOCUMENT as its own text content.
 *
 * Measured, before this existed:
 *
 *   `a <title> b <em>c</em> d`  ->  `<p>a  b &#x3C;em>c d</p>`
 *   `a <style> b`               ->  `<p>a </p>`
 *
 * The first mangled the emphasis into visible text; the second silently
 * deleted " b". Neither is a security problem - the sanitiser removes these
 * elements either way - but both destroy the user's document, which is the
 * failure this tool exists to avoid.
 *
 * Escaping the opening `<` is what the spec prescribes and what cmark-gfm
 * does, and it turns the loss into something the reader can see: the tag
 * appears as text, exactly where they wrote it.
 *
 * APPLIED TO THE INPUT, not to serialiser output. It rewrites raw HTML in the
 * mdast before `rehypeRaw` re-parses it, because by the time the parser has
 * run the damage has already happened.
 */
const TAGFILTER =
  /<(\/?)(title|textarea|style|xmp|iframe|noembed|noframes|script|plaintext)(?=[\t\n\f\r />])/gi;

function tagfilter() {
  return (tree: MdastRoot): void => {
    const walk = (node: MdastRoot | MdastContent): void => {
      if (node.type === 'html') {
        node.value = node.value.replace(TAGFILTER, '&lt;$1$2');
        return;
      }
      if ('children' in node) {
        for (const child of node.children) walk(child);
      }
    };

    walk(tree);
  };
}

/**
 * Lowercases a URL's scheme, before the allow-list is consulted.
 *
 * URL schemes are case-insensitive - RFC 3986 says so and every browser agrees
 * - but the sanitiser's protocol list is compared literally. So
 * `<MAILTO:FOO@BAR.BAZ>`, which CommonMark requires to be a link, lost its
 * href and rendered as a dead `<a>` with no destination.
 *
 * Normalising the scheme rather than widening the list keeps the allow-list
 * exactly as narrow as it was: `JAVASCRIPT:alert(1)` becomes `javascript:...`
 * and is then rejected by name rather than by accident of spelling, which is a
 * better reason for it to be rejected.
 *
 * Only the scheme is touched. The rest of a URL is case-sensitive and is left
 * alone.
 */
const URL_PROPERTIES = ['href', 'src', 'cite', 'longDesc'] as const;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

function normaliseSchemes() {
  return (tree: HastNodes): void => {
    const walk = (node: HastNodes): void => {
      if (node.type === 'element') {
        for (const property of URL_PROPERTIES) {
          const value = node.properties[property];
          if (typeof value !== 'string') continue;
          node.properties[property] = value.replace(SCHEME, (match) => match.toLowerCase());
        }
      }
      if (node.type === 'root' || node.type === 'element') {
        for (const child of node.children) walk(child);
      }
    };

    walk(tree);
  };
}

/**
 * Removes the comments that are machinery rather than content.
 *
 * Comments are kept now (see sanitise.ts), and that is right for
 * `<!-- prettier-ignore -->`. It is not right for what a Word paste carries:
 *
 *   <!--[if gte mso 9]><xml><w:WordDocument>...</w:WordDocument></xml><![endif]-->
 *   <!--StartFragment--> ... <!--EndFragment-->
 *
 * The first is a conditional comment holding an XML blob; the second is the
 * clipboard's own boundary marker. Neither was written by the person pasting,
 * and carrying either into their Markdown would be worse output than dropping
 * comments altogether was.
 */
const MACHINE_COMMENT =
  /^\s*(\[if\b|<!\[endif\]|Start(Fragment|Selection)|End(Fragment|Selection))/i;

function dropMachineComments() {
  return (tree: HastNodes): void => {
    const walk = (node: HastNodes): void => {
      if (node.type === 'root') {
        for (const child of node.children) walk(child);
        node.children = node.children.filter(
          (child) => child.type !== 'comment' || !MACHINE_COMMENT.test(child.value),
        );
      } else if (node.type === 'element') {
        for (const child of node.children) walk(child);
        node.children = node.children.filter(
          (child) => child.type !== 'comment' || !MACHINE_COMMENT.test(child.value),
        );
      }
    };

    walk(tree);
  };
}

/**
 * Removes an element but keeps its children, wherever it appears.
 *
 * Two plugins need exactly this, so it is written once. The two branches are
 * spelled out rather than made generic because a root may contain a doctype
 * and an element may not, and TypeScript is right to insist on the
 * difference - narrowing the node first is what keeps this cast-free.
 */
function unwrapWhere(tree: HastNodes, matches: (node: HastElement) => boolean): void {
  const walk = (node: HastNodes): void => {
    if (node.type === 'root') {
      for (const child of node.children) walk(child);
      node.children = node.children.flatMap((child) =>
        child.type === 'element' && matches(child) ? child.children : [child],
      );
    } else if (node.type === 'element') {
      for (const child of node.children) walk(child);
      node.children = node.children.flatMap((child) =>
        child.type === 'element' && matches(child) ? child.children : [child],
      );
    }
  };

  walk(tree);
}

/**
 * Unwraps links the sanitiser stripped the destination from.
 *
 * When an href fails the protocol allow-list, hast-util-sanitize removes the
 * attribute and leaves the element - so `[docs](irc://x)` became `<a>docs</a>`:
 * something that still looks like a link, is announced as a link, and goes
 * nowhere. Converted back to Markdown it became `[docs]()`, an empty
 * destination that is worse than no link at all.
 *
 * The text was never the problem, so the text is what survives.
 */
function unwrapDeadLinks() {
  return (tree: HastNodes): void => {
    unwrapWhere(tree, (node) => node.tagName === 'a' && node.properties.href === undefined);
  };
}

/**
 * Replaces an image whose source the sanitiser rejected with its alt text.
 *
 * The same argument as a dead link, and the same fix. An `<img>` with no `src`
 * renders as a broken-image icon next to the alt text - a picture of a
 * failure, where the alt text alone says the same thing without pretending
 * something went wrong at load time. An image with no alt either has nothing
 * to say and goes.
 */
function replaceDeadImages() {
  /** What one child becomes: itself, its alt text, or nothing. */
  const swap = (child: ElementContent): ElementContent[] => {
    if (child.type !== 'element' || child.tagName !== 'img') return [child];
    if (child.properties.src !== undefined) return [child];

    const alt = child.properties.alt;
    return typeof alt === 'string' && alt !== '' ? [{ type: 'text', value: alt }] : [];
  };

  return (tree: HastNodes): void => {
    /*
     * The two branches are spelled out rather than made generic for the same
     * reason as `unwrapWhere` above: a root may contain a doctype and an
     * element may not, so narrowing first is what keeps this cast-free.
     */
    const walk = (node: HastNodes): void => {
      if (node.type === 'root') {
        for (const child of node.children) walk(child);
        node.children = node.children.flatMap((child): RootContent[] =>
          child.type === 'doctype' ? [child] : swap(child),
        );
      } else if (node.type === 'element') {
        for (const child of node.children) walk(child);
        node.children = node.children.flatMap(swap);
      }
    };

    walk(tree);
  };
}

export interface MarkdownToHtmlOptions {
  /** Adds `id` attributes to headings, so they can be linked to. */
  readonly headingIds: boolean;
  /** GFM turns a bare https:// or www. into a link. Off leaves it as text. */
  readonly linkify: boolean;
}

/**
 * Undoes GFM's autolink literals, for `linkify: false`.
 *
 * remark-gfm has no switch for this - autolink literals come as part of the
 * GFM bundle along with tables, footnotes, strikethrough and task lists, and
 * dropping the plugin to lose one of the five is not a trade worth making.
 *
 * So the tree is corrected afterwards, and the test is the SOURCE TEXT rather
 * than the node's shape. By the time parsing is done, `https://x` written bare,
 * written as `<https://x>` and written as `[https://x](https://x)` are three
 * identical link nodes - nothing about the node says which it was. What does
 * distinguish them is the character the node starts at in the original
 * document: an autolink literal begins with the URL itself, the other two
 * begin with `<` or `[`. Those offsets are exactly what `position` records.
 */
function stripAutolinkLiterals() {
  return (tree: MdastRoot, file: VFile): void => {
    const source = String(file.value);

    const walk = (node: MdastRoot | MdastContent): void => {
      if (!('children' in node)) return;

      const replaced: MdastContent[] = [];
      for (const child of node.children) {
        const start = child.position?.start.offset;
        const opener = start === undefined ? '' : source.charAt(start);

        if (child.type === 'link' && opener !== '[' && opener !== '<') {
          // A bare URL. Keep the words, lose the link.
          replaced.push(...child.children);
          continue;
        }

        walk(child);
        replaced.push(child);
      }

      node.children = replaced;
    };

    walk(tree);
  };
}

export interface HtmlToMarkdownOptions {
  readonly bullet: '-' | '*' | '+';
  readonly emphasis: '_' | '*';
  readonly strong: '_' | '*';
  readonly fence: '`' | '~';
  /** ATX is `# Heading`; setext underlines with = and - and only reaches h2. */
  readonly setext: boolean;
  /** What to do with markup that has no Markdown equivalent. */
  readonly unsupported: 'drop' | 'keep' | 'text';
}

export interface HtmlToTextOptions {
  /** Renders `[label](url)` style trailing URLs rather than dropping them. */
  readonly keepLinkUrls: boolean;
  readonly listMarker: '-' | '*' | 'none';
  readonly tables: 'rows' | 'drop';
}

/**
 * Markdown → HTML.
 *
 * `allowDangerousHtml` plus `rehypeRaw` is what lets a raw HTML block inside
 * Markdown be parsed as markup rather than escaped into visible angle
 * brackets - which is what GitHub does and what anyone converting a README
 * expects. It is only safe BECAUSE rehypeSanitize runs immediately afterwards:
 * the raw HTML becomes real tree nodes, and then the allow-list deletes
 * everything it does not recognise. Removing the sanitise step would turn this
 * line into an XSS hole, which is why they are written together.
 */
export function markdownToHtml(markdown: string, options: MarkdownToHtmlOptions): string {
  /*
   * One chain, with the optional plugins passed as an empty list when they are
   * off, rather than reassigning a `let`. Every `.use()` refines the
   * processor's type parameters - mdast in, hast out - so putting it through a
   * variable of a fixed type erases exactly the information that makes the
   * final `processSync` type-check.
   */
  const html = unified()
    .use(remarkParse)
    .use(remarkGfm)
    /*
     * MATH IS PRESERVED, NOT RENDERED, and `$...$` is deliberately off.
     *
     * Without this, `$$ ... $$` is ordinary paragraph text, and Markdown's
     * backslash escapes eat the LaTeX: `\\,` becomes a comma and `\\\\` - the
     * line break in every matrix - becomes a single backslash. Parsing it as
     * math keeps the source exactly, and it comes back as a ```math fence,
     * which is what GitHub renders.
     *
     * `singleDollarTextMath: false` because single dollars are ambiguous with
     * money, and money is far commoner in a document than inline maths.
     * Measured: with it on, "It costs $5 and $10 today." became
     * `It costs <code class="language-math">5 and </code>10 today.` Block
     * math has no such ambiguity - a line of `$$` is not something prose
     * contains by accident.
     */
    .use(remarkMath, { singleDollarTextMath: false })
    .use(tagfilter)
    .use(options.linkify ? [] : [stripAutolinkLiterals])
    .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: '' })
    .use(rehypeRaw)
    // Schemes are case-insensitive; the allow-list below is not. Normalising
    // first is what stops `<MAILTO:...>` losing its destination.
    .use(normaliseSchemes)
    // Slugs BEFORE sanitising, so the ids it generates face the same
    // allow-list as any other attribute rather than being trusted for being
    // ours.
    .use(options.headingIds ? [rehypeSlug] : [])
    .use(rehypeSanitize, SANITISE_SCHEMA)
    // After sanitising: an href the allow-list rejected is gone by now, and a
    // link with nowhere to go is worse than the words on their own.
    .use(unwrapDeadLinks)
    .use(replaceDeadImages)
    .use(dropMachineComments)
    .use(namespaceIds)
    .use(tidyWhitespace)
    .use(rehypeStringify)
    .processSync(markdown);

  return String(html);
}

/** Identifier attributes that get namespaced, matching the sanitiser default. */
const IDENTIFIER_PROPERTIES = ['id', 'name', 'ariaDescribedBy', 'ariaLabelledBy'] as const;

export const ID_NAMESPACE = 'user-content-';

/**
 * Namespaces author-supplied identifiers, and points in-document links at them.
 *
 * Two real bugs, both found by the semantic-stability property test, both
 * caused by hast-util-sanitize's built-in clobbering:
 *
 *   1. IT IS NOT IDEMPOTENT. It prefixes any id it is given, including one
 *      that already carries the prefix. Convert a document, convert the result
 *      again, and `user-content-fn-1` becomes
 *      `user-content-user-content-fn-1`, then grows another prefix every pass.
 *      That is what made md → html → md → html produce different HTML from
 *      md → html.
 *   2. IT NEVER TOUCHED href. An id renamed to `user-content-fn-1` left every
 *      link to `#fn-1` pointing at nothing, so footnote references and heading
 *      anchors were all broken.
 *
 * This does the same job with both faults fixed: identifiers are prefixed only
 * if they are not already prefixed, and fragment hrefs are moved to match. The
 * protection is worth keeping - an `id="location"` can shadow a global
 * wherever this output ends up pasted - it just has to be applied by something
 * that can be applied twice.
 */
function namespaceIds() {
  return (tree: HastNodes): void => {
    /*
     * TWO PASSES, because the second one needs to know the answer to the
     * first. Pass one namespaces every identifier the document DEFINES; pass
     * two moves the references that point at them.
     *
     * The naive single pass rewrote every fragment href it saw, whether or not
     * anything in the document answered to that name - so `[jump](#setup)`
     * became `#user-content-setup` and pointed at nothing, turning a working
     * anchor into a dead one. A reference is only ours to rewrite if we are
     * the reason the target moved.
     */
    const defined = new Set<string>();

    const collect = (node: HastNodes): void => {
      if (node.type === 'element') {
        for (const property of IDENTIFIER_PROPERTIES as readonly string[]) {
          const value = node.properties[property];
          if (property !== 'id' && property !== 'name') continue;
          if (typeof value === 'string' && value !== '') {
            defined.add(value.startsWith(ID_NAMESPACE) ? value.slice(ID_NAMESPACE.length) : value);
          }
        }
      }
      if (node.type === 'root' || node.type === 'element') {
        for (const child of node.children) collect(child);
      }
    };

    /** Prefixes one identifier, if it is not prefixed already. */
    const prefix = (value: string): string =>
      value.startsWith(ID_NAMESPACE) ? value : `${ID_NAMESPACE}${value}`;

    const walk = (node: HastNodes): void => {
      if (node.type === 'element') {
        for (const property of IDENTIFIER_PROPERTIES as readonly string[]) {
          const value = node.properties[property];

          if (typeof value === 'string' && value !== '') {
            node.properties[property] = prefix(value);
          } else if (Array.isArray(value)) {
            /*
             * ARIA reference lists are space-separated token lists, and hast
             * parses them into an array - which the string branch above
             * silently skipped. The result was a footnote whose
             * `aria-describedby="footnote-label"` pointed at an id that had
             * been renamed to `user-content-footnote-label`: a dangling
             * reference in the one place a screen reader needs a working one.
             */
            node.properties[property] = value.map((token) =>
              typeof token === 'string' ? prefix(token) : token,
            );
          }
        }

        const href = node.properties.href;
        if (typeof href === 'string' && href.startsWith('#')) {
          const target = href.slice(1);
          if (target !== '' && !target.startsWith(ID_NAMESPACE) && defined.has(target)) {
            node.properties.href = `#${ID_NAMESPACE}${target}`;
          }
        }
      }

      if (node.type === 'root' || node.type === 'element') {
        for (const child of node.children) walk(child);
      }
    };

    collect(tree);
    walk(tree);
  };
}

/**
 * Elements the allow-list permits but Markdown cannot express.
 *
 * An explicit list, because hast-util-to-mdast has no catch-all handler: a
 * handler is registered per tag name. That is a fair trade - a wildcard would
 * silently change behaviour for any element a future sanitiser schema starts
 * allowing, whereas this list is a decision somebody made.
 *
 * Anything NOT here either already has an mdast equivalent (`<p>`, `<ul>`,
 * `<code>`) or never reaches this stage at all - `<abbr>`, `<mark>`, `<cite>`
 * and friends are not in the sanitiser's allow-list, so they have already been
 * unwrapped to their text by the time the option is consulted. This list was
 * checked against the schema rather than guessed: it is exactly the
 * intersection of "allowed through" and "no Markdown equivalent".
 */
const NO_MARKDOWN_EQUIVALENT: readonly string[] = [
  'div',
  'span',
  'kbd',
  'samp',
  'var',
  'sub',
  'sup',
  'ins',
  'q',
  'details',
  'summary',
  'dl',
  'dt',
  'dd',
  // Added to the sanitiser's allow-list after a per-element analysis; see
  // ALSO_ALLOWED in sanitise.ts. `keep` can now actually keep them, which it
  // could not while they were being unwrapped before it was consulted.
  'abbr',
  'figure',
  'figcaption',
  'mark',
  'cite',
  'time',
  'small',
];

/**
 * Of the elements Markdown cannot express, the ones that are INLINE.
 *
 * These are kept whole, because their content is phrasing: there is no blank
 * line to be had inside a `<kbd>`, so the raw-HTML-block rule that forces the
 * others apart cannot bite. Keeping them whole also keeps them on one line,
 * which is what inline HTML in Markdown should look like.
 */
const KEEP_WHOLE = new Set([
  'span',
  'kbd',
  'samp',
  'var',
  'sub',
  'sup',
  'ins',
  'q',
  'abbr',
  'mark',
  'cite',
  'time',
  'small',
]);

/** Re-serialises just an element's start tag, attributes included. */
function openingTag(node: HastElement): string {
  const empty: HastElement = { ...node, children: [] };
  return toHtml(empty).replace(new RegExp(`</${node.tagName}>$`), '');
}

/**
 * `<ol start="0">`, which upstream renumbers to 1.
 *
 * hast-util-to-mdast@10.1.2, lib/handlers/list.js:
 *
 *   start = node.properties && node.properties.start
 *     ? Number.parseInt(String(node.properties.start), 10)
 *     : 1
 *
 * A truthiness test on a number, so the one value that is falsy - zero - is
 * the one value it drops. Every other start survives, which is what made this
 * look like a rounding quirk rather than a bug for so long.
 *
 * The default handler is called and its answer corrected, rather than the
 * whole thing reimplemented: `state.toSpecificContent` and `listItemsSpread`
 * are internal, and duplicating them to fix one line would be trading a small
 * upstream bug for a large local one. Delete this when upstream reads the
 * property rather than testing it.
 */
const orderedList: Handle = (state, node) => {
  const result = defaultHandlers.ol(state, node);

  // No guard around the parse: hast may hand back the parsed number or the
  // raw string, and a missing attribute stringifies to something parseInt
  // rejects - so NaN is the only "absent" case there is.
  const parsed = Number.parseInt(String(node.properties.start), 10);
  if (!Number.isNaN(parsed)) result.start = parsed;

  return result;
};

/**
 * Undoes Google Docs' habit of wrapping a whole paste in a bold that is not.
 *
 * A copy out of Google Docs arrives inside
 * `<b style="font-weight:normal" id="docs-internal-guid-...">`, which is a
 * `<b>` that explicitly asks not to be bold. Converted naively, EVERY WORD of
 * a pasted document comes out `**bold**` - which is not a subtle failure, and
 * Google Docs is one of the two places people paste from.
 *
 * This has to run before the sanitiser, because the evidence is the `style`
 * attribute and the sanitiser is about to remove it. Both signals are checked:
 * the declared weight, and the Docs-specific id.
 */
/*
 * ANCHORED TO THE START OF A DECLARATION, which matters more than it looks.
 * The first version matched anywhere, so `mso-bidi-font-weight: normal` -
 * a Word-specific property that says nothing about the visual weight, and
 * which Word puts on text that IS bold - unwrapped a genuine bold. Caught by
 * the Word paste case in hardening.test.ts.
 */
const NOT_BOLD = /(^|;)\s*font-weight\s*:\s*(normal|[1-4]00)\b/i;

function unwrapFakeBold() {
  return (tree: HastNodes): void => {
    unwrapWhere(tree, (node) => {
      if (node.tagName !== 'b' && node.tagName !== 'strong') return false;
      const style = node.properties.style;
      const id = node.properties.id;
      return (
        (typeof style === 'string' && NOT_BOLD.test(style)) ||
        (typeof id === 'string' && id.startsWith('docs-internal-guid'))
      );
    });
  };
}

/** Handlers implementing the `unsupported` option. */
function unsupportedHandlers(
  mode: HtmlToMarkdownOptions['unsupported'],
): NonNullable<ToMdastOptions['handlers']> {
  if (mode === 'drop') {
    return Object.fromEntries(NO_MARKDOWN_EQUIVALENT.map((tag) => [tag, () => undefined]));
  }

  if (mode === 'keep') {
    /*
     * An `html` mdast node holds raw markup that the serialiser writes out
     * verbatim, and Markdown permits inline HTML - so for an INLINE element
     * this is lossless: it comes back exactly as it went in, attributes and
     * all, having already passed the sanitiser on the way through.
     *
     * FOR A BLOCK ELEMENT IT IS NOT, and the reason is a rule of CommonMark
     * rather than anything about this code. A raw HTML block ends at the first
     * BLANK LINE. So serialising a whole `<details>` subtree as one string
     * produced Markdown that could not be read back: a real README with a
     * fenced code block inside `<details>` came back with the block cut in
     * half, the second half re-parsed as paragraphs, and its indentation
     * gone. Found by round-tripping remark's own readme.
     *
     * So a block element is written as three things - its opening tag, its
     * children converted to REAL MARKDOWN, and its closing tag - which is both
     * what survives a re-parse and what the document probably looked like
     * before anyone converted it. A fenced block inside `<details>` stays a
     * fenced block.
     */
    return Object.fromEntries(
      NO_MARKDOWN_EQUIVALENT.map((tag) => [
        tag,
        KEEP_WHOLE.has(tag)
          ? (((_state: State, node: HastElement) => ({
              type: 'html' as const,
              value: toHtml(node),
            })) satisfies Handle)
          : (((state: State, node: HastElement) => [
              { type: 'html' as const, value: openingTag(node) },
              ...state.all(node),
              { type: 'html' as const, value: `</${node.tagName}>` },
            ]) satisfies Handle),
      ]),
    );
  }

  // 'text' is hast-util-to-mdast's own default: the wrapper goes, the words
  // inside it stay. Nothing to register.
  return {};
}

/**
 * CODE CONTENT, RESTORED AFTER hast-util-to-mdast HAS MINIFIED IT.
 *
 * `toMdast` clones the tree and runs `rehype-minify-whitespace` over the clone
 * before any handler is consulted. That is right for prose and wrong for code,
 * and it is wrong in a way no option reaches: whitespace sensitivity is a
 * `switch` on tag name inside `hast-util-minify-whitespace`, `<pre>` is in it
 * and a bare inline `<code>` is not. So `<code>a  b</code>` arrives at the
 * `inlineCode` handler already collapsed to `a b`, with the original gone.
 *
 * Measured, and both directions of the loss:
 *
 *   `<code>a  b</code>`            ->  `a b`     (a space of the program lost)
 *   `<pre><code>a\n\n</code></pre>`->  `a`       (a blank line of it lost)
 *
 * The second is the `code` handler's own `trimTrailingLines`, which strips
 * EVERY trailing newline where mdast wants exactly one removed - the one that
 * mdast-to-hast adds when it renders a fence.
 *
 * The fix for both is to record the text off the real tree on the way past,
 * and hand it back to a handler that would otherwise have to trust the clone.
 * The clone keeps `position`, and a parsed node's source offsets are a
 * reliable identity - the same mechanism `stripAutolinkLiterals` uses above.
 * A node with no position (nothing here makes one) falls through to the
 * default, so the worst case is today's behaviour rather than a crash.
 */
type VerbatimText = Map<string, string>;

function positionKey(node: HastElement): string | null {
  const { start, end } = node.position ?? {};
  if (start?.offset === undefined || end?.offset === undefined) return null;
  return `${start.offset.toString()}:${end.offset.toString()}`;
}

/** Every descendant text node, concatenated: the element's content as parsed. */
function rawText(node: HastNodes): string {
  if (node.type === 'text') return node.value;
  if (node.type !== 'root' && node.type !== 'element') return '';
  return node.children.map((child) => rawText(child)).join('');
}

/** Records the exact text of every code element, before anything minifies it. */
function recordVerbatimText(into: VerbatimText) {
  // A plugin, so an extra level of function: unified calls this to GET the
  // transformer, and calls the transformer with the tree.
  return () =>
    (tree: HastNodes): void => {
      const walk = (node: HastNodes): void => {
        if (node.type !== 'root' && node.type !== 'element') return;

        if (node.type === 'element' && (node.tagName === 'code' || node.tagName === 'pre')) {
          const key = positionKey(node);
          if (key !== null) into.set(key, rawText(node));
        }

        for (const child of node.children) walk(child);
      };

      walk(tree);
    };
}

/**
 * `<pre>` -> a fenced code block, with its trailing blank lines intact.
 *
 * Built on the default handler rather than replacing it, so the language class
 * is still read by the code that owns that job - the same shape as
 * `orderedList` below. Only the value is corrected, and only by removing the
 * ONE trailing newline that mdast-to-hast adds: `<pre><code>a\n</code></pre>`
 * is the fence containing `a`, and `<pre><code>a\n\n</code></pre>` is the
 * fence containing `a` and a blank line after it.
 */
function codeBlock(recorded: VerbatimText): Handle {
  return (state, node) => {
    // Typed as returning a `Code` node, so there is nothing to narrow here
    // and a defensive check would be a check the compiler has already made.
    const result = defaultHandlers.pre(state, node);
    const exact = recorded.get(positionKey(node) ?? '');

    if (exact !== undefined) result.value = exact.replace(/\n$/, '');
    return result;
  };
}

/**
 * `<code>` -> a code span, with its interior spacing intact.
 *
 * Line endings still become single spaces, because that is CommonMark's own
 * rule for a code span and not something lost on the way: a code span cannot
 * contain a line break, so there is no spelling of `a\nb` for the serialiser
 * to write. Spaces and tabs are content and are kept exactly.
 */
function inlineCode(recorded: VerbatimText): Handle {
  return (state, node) => {
    const result = defaultHandlers.code(state, node);
    const exact = recorded.get(positionKey(node) ?? '');

    if (exact !== undefined) result.value = exact.replace(/\r?\n/g, ' ');
    return result;
  };
}

/**
 * HTML → Markdown.
 *
 * `fragment: true` because the input is a snippet, not a document: without it
 * the parser helpfully invents html/head/body around whatever it is given.
 */
export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions): string {
  // Filled in by the plugin below and read by the two code handlers. Local to
  // the call, so two conversions running at once cannot see each other's text.
  const verbatim: VerbatimText = new Map();

  return String(
    unified()
      .use(rehypeParse, { fragment: true })
      // Before the sanitiser, because it is the `style` attribute that gives
      // the game away and the sanitiser is about to remove it.
      .use(unwrapFakeBold)
      .use(normaliseSchemes)
      .use(rehypeSanitize, SANITISE_SCHEMA)
      .use(unwrapDeadLinks)
      .use(replaceDeadImages)
      .use(dropMachineComments)
      /*
       * What happens to markup Markdown cannot express - a <div>, a <span>,
       * an <abbr>. 'keep' writes the element back as inline HTML, which is
       * valid Markdown and lossless; 'text' keeps the words and discards the
       * wrapper; 'drop' removes it and its content.
       */
      // Last thing before the conversion, so what it records is the tree the
      // conversion is about to be handed.
      .use(recordVerbatimText(verbatim))
      .use(rehypeRemark, {
        handlers: {
          ...unsupportedHandlers(options.unsupported),
          ol: orderedList,
          pre: codeBlock(verbatim),
          code: inlineCode(verbatim),
        },
      })
      .use(remarkGfm)
      .use(remarkStringify, {
        bullet: options.bullet,
        emphasis: options.emphasis,
        strong: options.strong,
        fence: options.fence,
        setext: options.setext,
        // Fenced, always. Indented code blocks cannot carry a language hint,
        // and losing the hint is a real loss on the way back to HTML.
        fences: true,
        /*
         * ALWAYS `[text](url)`, never the `<url>` autolink shorthand.
         *
         * Not cosmetic. The serialiser decides to write an autolink on a
         * looser rule than the parser uses to read one back, and the gap is
         * real: `<a href="mailto:+@.A">+@.A</a>` came out as `<+@.A>`, which
         * CommonMark's email-autolink grammar rejects (a domain label cannot
         * begin with a dot), so re-rendering it produced escaped text and a
         * stray angle bracket instead of the link. GFM's linkify manufactures
         * exactly this from ordinary prose, so it is reachable from a paste
         * rather than only from a hand-written oddity.
         *
         * The resource form always parses back to the link it came from. It
         * costs the prettier spelling of a plain URL, which is the category of
         * thing the round-trip explicitly does not promise to preserve, and
         * buys an invariant that actually holds. Found by the semantic
         * stability property; asserted directly below it.
         */
        resourceLink: true,
        rule: '-',
      })
      .processSync(html),
  );
}

/**
 * THE CHARACTER THAT CANNOT BE IN THE TEXT.
 *
 * Code blocks are rendered once, lifted out, and put back after the
 * line-level tidy-up in `htmlToText` has run. That needs a marker which
 * cannot collide with the user's content, and U+0000 is one by construction
 * rather than by hope: the HTML tokenizer disposes of every NUL in character
 * data before a tree exists, so nothing reaching this function can contain
 * one. Every path here parses HTML first, the Markdown one included.
 * Asserted by name in the regression suite.
 */
const VERBATIM_MARK = '\u0000';

/**
 * HTML → plain text.
 *
 * Sanitised first even though the output carries no markup at all. Two
 * reasons: a `<script>` body would otherwise be dumped into the text as its
 * source code, and the text of an element the allow-list rejects is not
 * content anybody asked to read.
 */
export function htmlToText(html: string, options: HtmlToTextOptions): string {
  const tree = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeSanitize, SANITISE_SCHEMA)
    .runSync(unified().use(rehypeParse, { fragment: true }).parse(html)) as HastNodes;

  recordListParents(tree);

  /*
   * CODE IS HELD OUT OF THE TIDY-UP, and this is the second time that lesson
   * has had to be learnt in this file.
   *
   * `tidyWhitespace` says it walks the tree rather than running a regex over
   * the finished string, "because a regex could not tell the newlines between
   * two table rows from the ones inside a fenced code block". The three
   * string operations below WERE that regex, and they did exactly that
   * damage:
   *
   *   - collapsing three or more newlines flattened two blank lines inside a
   *     code block into one;
   *   - stripping trailing whitespace per line removed trailing spaces that
   *     are part of the program;
   *   - `trim()` ate the four-space indent of the FIRST line of a document
   *     that opens with a code block, leaving line one flush against the
   *     margin and every line after it indented.
   *
   * All three are still wanted BETWEEN blocks - that is what stops a heading
   * and a list running together, and what keeps a converted document free of
   * invisible trailing spaces. So each code block is rendered once, replaced
   * by a marker, and substituted back afterwards. The marker is a single
   * token on a line of its own, so nothing the tidy-up does can reach inside
   * it.
   */
  const blocks: string[] = [];
  const rendered = renderText(tree, options, 0, false, blocks);

  const tidied = rendered
    .split('\n')
    // No trailing whitespace on any line: it is invisible, it survives a
    // paste, and it is what makes a diff of two conversions unreadable.
    .map((line) => line.replace(/[^\S\n]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    /*
     * BLANK LINES AT THE EDGES GO; INDENTATION ON THE FIRST LINE STAYS.
     *
     * This was `trim()`, and the difference is not cosmetic - it is what makes
     * converting to text IDEMPOTENT. Plain text is valid HTML input, so
     * running the conversion twice has to produce what running it once did.
     * A document that opens with a code block starts with four spaces, and
     * `trim()` removed them on the second pass. The property test caught it
     * with `<pre><code>code();</code></pre><h1>Title</h1>` the moment the
     * first pass started indenting that line correctly.
     *
     * Stripping whole blank lines is what was wanted all along. Every line has
     * already had its trailing whitespace removed above, so a line that was
     * only spaces is empty by the time these two run.
     */
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');

  return substituteBlocks(tidied, blocks);
}

/**
 * Puts the lifted code blocks back where their markers are.
 *
 * A REPLACER FUNCTION, not a replacement string. A string replacement
 * interprets `$&`, `$1` and friends, and `$&` in a shell snippet or a regex
 * sample is exactly the sort of thing that arrives inside a code block on this
 * tool's input.
 */
function substituteBlocks(text: string, blocks: readonly string[]): string {
  let out = text;
  for (const [index, block] of blocks.entries()) {
    out = out.replace(`${VERBATIM_MARK}${index.toString()}${VERBATIM_MARK}`, () => block);
  }
  return out;
}

/**
 * PLAIN TEXT: STRUCTURE SURVIVES, SYNTAX DOES NOT.
 *
 * That is the whole policy, and every decision below follows from it. The
 * option is called "strip formatting", and formatting is what goes: emphasis
 * markers, link syntax, fences, escaping, table pipes. What stays is anything
 * a reader needs in order to still understand the shape of the document.
 *
 * The previous version dropped both, and the result was unreadable on a real
 * document: headings became indistinguishable from paragraphs, an ordered list
 * came out as bullets, nested lists flattened to one level, task list
 * checkboxes vanished along with their state, blockquotes lost their
 * attribution, and code blocks sat flush against the prose around them.
 * Measured on a long generated answer, which is the input this tool exists for.
 *
 * The decisions, each with its reason:
 *
 *   HEADINGS keep a `#` prefix. The alternative is losing the hierarchy of a
 *   long document entirely. `#` is the marker every developer reads without
 *   thinking, and unlike setext underlining it works past two levels.
 *
 *   ORDERED LISTS get their real numbers, honouring `start`. Rendering
 *   `1. 2. 3.` as three bullets was simply a bug: the marker option is about
 *   the bullet character and was being applied to numbers as well.
 *
 *   NESTED LISTS indent two spaces per level. Depth is structure.
 *
 *   TASK LISTS keep `[x]` and `[ ]`. The state is the information; an item
 *   with its checkbox removed says the opposite of what it meant half the
 *   time.
 *
 *   CODE BLOCKS are indented four spaces rather than fenced. Indentation is
 *   layout and a fence is syntax, and four spaces is what a plain-text reader
 *   has meant by "this is code" since long before Markdown.
 *
 *   BLOCKQUOTES keep `> `. Without it a quotation silently becomes the
 *   author's own words.
 *
 *   TABLES become aligned columns, not tab-separated fields. The earlier
 *   choice optimised for pasting into a spreadsheet - but this app has a
 *   structured-data tool that produces real CSV, and plain text is for
 *   reading. A table whose columns no longer line up is much harder to read
 *   than one that has merely lost its borders.
 */

/** Block elements that should end the current line. */
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'figure',
  'figcaption',
  'dl',
  'dt',
  'details',
  'summary',
]);

const HEADING = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Which list an item belongs to.
 *
 * hast nodes carry no parent pointer, so it is recorded on the way down. A
 * WeakMap rather than a field on the node, because the tree belongs to the
 * sanitiser and decorating other people's nodes is how trees acquire mystery
 * properties.
 */
const ITEM_PARENT = new WeakMap<HastElement, HastElement>();

function recordListParents(tree: HastNodes): void {
  const walk = (node: HastNodes): void => {
    if (node.type !== 'root' && node.type !== 'element') return;

    for (const child of node.children) {
      if (
        node.type === 'element' &&
        (node.tagName === 'ul' || node.tagName === 'ol') &&
        child.type === 'element' &&
        child.tagName === 'li'
      ) {
        ITEM_PARENT.set(child, node);
      }
      walk(child);
    }
  };

  walk(tree);
}

/** `1. ` for an ordered list, honouring `start`; the chosen bullet otherwise. */
function listMarker(item: HastElement, options: HtmlToTextOptions): string {
  const parent = ITEM_PARENT.get(item);

  if (parent?.tagName === 'ol') {
    const raw = Number.parseInt(String(parent.properties.start), 10);
    const start = Number.isNaN(raw) ? 1 : raw;
    const index = parent.children.filter((child) => child.type === 'element').indexOf(item);
    return `${String(start + Math.max(index, 0))}. `;
  }

  return options.listMarker === 'none' ? '' : `${options.listMarker} `;
}

/** `[x] `, `[ ] `, or nothing, from the checkbox a GFM task item carries. */
function checkboxState(item: HastElement): string {
  const box = item.children.find((child) => child.type === 'element' && child.tagName === 'input');
  if (box?.type !== 'element') return '';
  return box.properties.checked === true ? '[x] ' : '[ ] ';
}

/** Renders one table as aligned columns, with a rule under the header. */
function renderTable(node: HastElement, options: HtmlToTextOptions): string {
  const rows: string[][] = [];
  let headerRows = 0;

  const collect = (current: HastNodes, inHead: boolean): void => {
    if (current.type !== 'element' && current.type !== 'root') return;

    if (current.type === 'element' && current.tagName === 'tr') {
      rows.push(
        current.children
          .filter((cell) => cell.type === 'element')
          .map((cell) => {
            /*
             * A cell gets its OWN block list, substituted straight away.
             * A table cell is collapsed to one line whatever is in it, so
             * holding its code out of that would be pointless - but leaving a
             * marker in the text would print a stray control character in the
             * middle of the table, which is how this was found.
             */
            const cellBlocks: string[] = [];
            const text = renderText(cell, options, 0, false, cellBlocks);
            return substituteBlocks(text, cellBlocks).replace(/\s+/g, ' ').trim();
          }),
      );
      if (inHead) headerRows += 1;
      return;
    }

    const head = inHead || (current.type === 'element' && current.tagName === 'thead');
    for (const child of current.children) collect(child, head);
  };

  collect(node, false);
  if (rows.length === 0) return '';

  const columns = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, index) =>
    Math.max(...rows.map((row) => (row[index] ?? '').length)),
  );

  const line = (row: readonly string[]): string =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();

  const out = rows.map(line);
  if (headerRows > 0) {
    // A rule under the header, sized to the columns, so a reader can see where
    // the data starts without counting.
    out.splice(headerRows, 0, widths.map((width) => '-'.repeat(width)).join('  '));
  }

  return `\n${out.join('\n')}\n`;
}

/**
 * Walks the sanitised tree into plain text.
 *
 * Hand-written rather than `hast-util-to-text` alone, because the options here
 * - keeping link URLs, choosing a list marker, deciding what a table becomes -
 * are decisions about presentation that a generic text extractor has no
 * opinion about.
 */
function renderText(
  node: HastNodes,
  options: HtmlToTextOptions,
  depth: number,
  verbatim: boolean,
  /** Rendered code blocks, lifted out of the text. See `htmlToText`. */
  blocks: string[],
): string {
  if (node.type === 'text') {
    /*
     * A whitespace-only text node containing a newline is the line break the
     * serialiser put BETWEEN two elements, not content. Emitting it put a
     * blank line between every pair of list items and every table row - which
     * is what made a checklist twice as long as it should be. Inside `pre` the
     * same node is a line of the program, so the flag is threaded down.
     */
    if (!verbatim && node.value.trim() === '' && node.value.includes('\n')) return '';
    return node.value;
  }
  if (node.type === 'comment') return '';

  if (node.type === 'root') {
    return node.children
      .map((child) => renderText(child, options, depth, verbatim, blocks))
      .join('');
  }

  if (node.type !== 'element') return '';

  const tag = node.tagName;
  const indent = '  '.repeat(depth);

  if (tag === 'br') return '\n';
  if (tag === 'hr') return '\n---\n';
  // The checkbox is written by its list item, which is what knows the state.
  if (tag === 'input') return '';

  if (tag === 'img') {
    const alt = node.properties.alt;
    return typeof alt === 'string' ? alt : '';
  }

  if (tag === 'table') {
    return options.tables === 'drop' ? '' : renderTable(node, options);
  }

  /*
   * DEPTH IS LIST DEPTH, not tree depth. It used to increment on every
   * element, so a top-level list item sat two spaces in merely because it
   * was a grandchild of the root. Only a list item deepens it, which is the
   * only nesting plain text has a way to show.
   */
  const inner = node.children
    .map((child) => renderText(child, options, depth, verbatim || tag === 'pre', blocks))
    .join('');

  if (HEADING.has(tag)) {
    return `\n${'#'.repeat(Number(tag.slice(1)))} ${inner.trim()}\n`;
  }

  if (tag === 'a' && options.keepLinkUrls) {
    const href = node.properties.href;
    const text = inner.trim();
    /*
     * Only when the URL says something the text does not. `mailto:` is checked
     * as well: an email autolink renders its address as the text, so without
     * this every one came out as "ops@x.org (mailto:ops@x.org)".
     */
    if (typeof href === 'string' && href !== '' && href !== text && href !== `mailto:${text}`) {
      return `${inner} (${href})`;
    }
    return inner;
  }

  if (tag === 'pre') {
    // Four spaces on top of whatever indentation the surrounding list gives
    // it, with the code's own indentation preserved inside that.
    const body = inner.replace(/\n$/, '');
    const block = body
      .split('\n')
      /*
       * A BLANK LINE STAYS BLANK rather than becoming four spaces of
       * whitespace nobody can see. It used to be indented like any other, and
       * the strip that removed it again is one of the operations this block is
       * now held out of - so it has to arrive clean instead.
       */
      .map((line) => (line === '' ? '' : `${indent}    ${line}`))
      .join('\n');

    blocks.push(block);
    return `\n${VERBATIM_MARK}${(blocks.length - 1).toString()}${VERBATIM_MARK}\n`;
  }

  if (tag === 'blockquote') {
    return `\n${inner
      .trim()
      .split('\n')
      .map((line) => `${indent}> ${line}`.trimEnd())
      .join('\n')}\n`;
  }

  if (tag === 'li') {
    /*
     * The item's own contents are one level deeper, which is what indents a
     * nested list under its parent. Blank lines WITHIN one item are
     * collapsed: remark marks a whole list loose as soon as a single item
     * is spread, so an ordinary checklist with one nested item arrived with
     * every line double-spaced.
     */
    const body = node.children
      .map((child) => renderText(child, options, depth + 1, verbatim, blocks))
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .split('\n');

    const head = `${indent}${listMarker(node, options)}${checkboxState(node)}${body[0] ?? ''}`;
    const rendered = [head, ...body.slice(1)].join('\n');

    /*
     * A one-line item stays tight against its neighbours; an item carrying a
     * code block or a nested list gets a blank line after it. Uniform spacing
     * either crushes the long items together or doubles the length of a plain
     * checklist, and the length of the item is what decides which.
     */
    return body.length > 1 ? `${rendered}\n\n` : `${rendered}\n`;
  }

  if (tag === 'ul' || tag === 'ol') {
    return depth === 0 ? `\n${inner.trimEnd()}\n` : `\n${inner.trimEnd()}`;
  }

  if (BLOCK.has(tag)) return `\n${indent}${inner.trim()}\n`;

  return inner;
}

/** Text of a hast tree, for tests and for callers that want no formatting. */
export function plainTextOf(tree: HastNodes): string {
  return toText(tree);
}
