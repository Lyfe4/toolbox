import { toHtml } from 'hast-util-to-html';
import { toText } from 'hast-util-to-text';
import rehypeParse from 'rehype-parse';
import rehypeRaw from 'rehype-raw';
import rehypeRemark from 'rehype-remark';
import rehypeSanitize from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import remarkStringify from 'remark-stringify';
import { unified } from 'unified';

import { SANITISE_SCHEMA } from './sanitise';

import type { Element as HastElement, Nodes as HastNodes } from 'hast';
import type { Options as ToMdastOptions } from 'hast-util-to-mdast';
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
    .use(options.linkify ? [] : [stripAutolinkLiterals])
    .use(remarkRehype, { allowDangerousHtml: true, clobberPrefix: '' })
    .use(rehypeRaw)
    // Slugs BEFORE sanitising, so the ids it generates face the same
    // allow-list as any other attribute rather than being trusted for being
    // ours.
    .use(options.headingIds ? [rehypeSlug] : [])
    .use(rehypeSanitize, SANITISE_SCHEMA)
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
    const walk = (node: HastNodes): void => {
      if (node.type === 'element') {
        // Indexed as plain strings: hast types `ariaDescribedBy` as
        // `string | string[]`, and a literal-union key makes TypeScript
        // demand the intersection of every member's type.
        for (const property of IDENTIFIER_PROPERTIES as readonly string[]) {
          const value = node.properties[property];
          if (typeof value === 'string' && value !== '' && !value.startsWith(ID_NAMESPACE)) {
            node.properties[property] = `${ID_NAMESPACE}${value}`;
          }
        }

        const href = node.properties.href;
        if (
          typeof href === 'string' &&
          href.startsWith('#') &&
          !href.startsWith(`#${ID_NAMESPACE}`)
        ) {
          node.properties.href = `#${ID_NAMESPACE}${href.slice(1)}`;
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
];

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
     * verbatim. Markdown permits inline HTML, so this is lossless - the
     * element comes back exactly as it went in, attributes and all, having
     * already passed the sanitiser on the way through.
     */
    return Object.fromEntries(
      NO_MARKDOWN_EQUIVALENT.map((tag) => [
        tag,
        (_state, node: HastElement) => ({ type: 'html', value: toHtml(node) }),
      ]),
    );
  }

  // 'text' is hast-util-to-mdast's own default: the wrapper goes, the words
  // inside it stay. Nothing to register.
  return {};
}

/**
 * HTML → Markdown.
 *
 * `fragment: true` because the input is a snippet, not a document: without it
 * the parser helpfully invents html/head/body around whatever it is given.
 */
export function htmlToMarkdown(html: string, options: HtmlToMarkdownOptions): string {
  return String(
    unified()
      .use(rehypeParse, { fragment: true })
      .use(rehypeSanitize, SANITISE_SCHEMA)
      /*
       * What happens to markup Markdown cannot express - a <div>, a <span>,
       * an <abbr>. 'keep' writes the element back as inline HTML, which is
       * valid Markdown and lossless; 'text' keeps the words and discards the
       * wrapper; 'drop' removes it and its content.
       */
      .use(rehypeRemark, { handlers: unsupportedHandlers(options.unsupported) })
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

  return renderText(tree, options)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'table',
  'tr',
  'hr',
  'br',
]);

/**
 * Walks the sanitised tree into plain text.
 *
 * Hand-written rather than `hast-util-to-text` alone, because the options here
 * - keeping link URLs, choosing a list marker, deciding what a table becomes -
 * are decisions about presentation that a generic text extractor has no
 * opinion about.
 */
function renderText(node: HastNodes, options: HtmlToTextOptions, depth = 0): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'comment') return '';

  if (node.type === 'root') {
    return node.children.map((child) => renderText(child, options, depth)).join('');
  }

  if (node.type !== 'element') return '';

  const tag = node.tagName;
  const inner = node.children.map((child) => renderText(child, options, depth + 1)).join('');

  if (tag === 'br') return '\n';
  if (tag === 'hr') return '\n---\n';

  if (tag === 'a' && options.keepLinkUrls) {
    const href = node.properties.href;
    // Only when the URL says something the text does not already.
    if (typeof href === 'string' && href !== '' && href !== inner) return `${inner} (${href})`;
    return inner;
  }

  if (tag === 'li') {
    const marker = options.listMarker === 'none' ? '' : `${options.listMarker} `;
    return `${marker}${inner.trim()}\n`;
  }

  if (tag === 'table') {
    return options.tables === 'drop' ? '' : `\n${inner}\n`;
  }

  if (tag === 'tr') {
    // Cells separated by a tab: it survives a paste into a spreadsheet, which
    // is the one thing anybody wants from a table as plain text.
    return `${node.children
      .map((child) => renderText(child, options, depth + 1).trim())
      .filter((cell) => cell !== '')
      .join('\t')}\n`;
  }

  if (BLOCK.has(tag)) return `\n${inner.trim()}\n`;

  return inner;
}

/** Text of a hast tree, for tests and for callers that want no formatting. */
export function plainTextOf(tree: HastNodes): string {
  return toText(tree);
}
