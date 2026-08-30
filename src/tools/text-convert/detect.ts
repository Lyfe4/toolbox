/** The formats this tool can read. Plain text is a target only - see README. */
export const SOURCE_FORMATS = ['markdown', 'html'] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

export const TARGET_FORMATS = ['markdown', 'html', 'text'] as const;
export type TargetFormat = (typeof TARGET_FORMATS)[number];

/**
 * What auto-detection concluded, and how sure it was.
 *
 * `confident` means a construct was found that only one format has.
 * `assumed` means nothing decisive was found and the fallback was taken -
 * which the UI reports differently, because a silent wrong guess on a
 * conversion is worse than being told to pick.
 */
export interface Detection {
  readonly format: SourceFormat;
  readonly confidence: 'confident' | 'assumed';
  /** One line, shown to the user. Says what was found, not just what was chosen. */
  readonly reason: string;
}

/**
 * A tag that only ever appears as markup.
 *
 * Deliberately a small list of BLOCK-level and structural tags rather than
 * "anything in angle brackets". Markdown documents are full of things that
 * look like tags - `<https://example.com>` autolinks, `<T>` in a code span,
 * `a < b` in prose - and treating those as HTML would send a perfectly good
 * README down the wrong pipeline.
 */
const STRUCTURAL_TAG =
  /<(?:html|head|body|div|section|article|main|aside|nav|header|footer|table|thead|tbody|tr|td|th|ul|ol|li|dl|dt|dd|p|h[1-6]|blockquote|pre|figure|form|span|strong|em|b|i|a|img|br|hr)\b[^>]*>/i;

/** Constructs that are Markdown and are not valid HTML markup. */
const MARKDOWN_SIGNALS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /^\s{0,3}#{1,6}\s+\S/m, what: 'an ATX heading' },
  { pattern: /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+\S/m, what: 'a list item' },
  { pattern: /^\s{0,3}>\s/m, what: 'a blockquote' },
  { pattern: /^\s{0,3}(?:```|~~~)/m, what: 'a fenced code block' },
  { pattern: /^\s{0,3}\|.*\|\s*$/m, what: 'a table row' },
  { pattern: /^\s{0,3}\[[^\]]+\]:\s+\S/m, what: 'a link reference definition' },
  { pattern: /\[[^\]]*\]\([^)]*\)/, what: 'an inline link' },
  { pattern: /(?:^|\s)(?:\*\*|__)\S[\s\S]*?(?:\*\*|__)/, what: 'strong emphasis' },
  { pattern: /~~\S[\s\S]*?~~/, what: 'strikethrough' },
  { pattern: /^\s{0,3}[-*_]{3,}\s*$/m, what: 'a thematic break' },
  { pattern: /^\s{0,3}\[\^[^\]]+\]:/m, what: 'a footnote definition' },
];

/**
 * Guesses which format a document is written in.
 *
 * CONSERVATIVE BY DESIGN, in a specific sense: it would rather admit it is
 * assuming than assert something it cannot support. The failure it is built to
 * avoid is not "picked the less likely option" but "said Markdown with
 * confidence about a fragment of HTML", because the user then has no reason to
 * look at the source control.
 *
 * The order matters. A structural HTML tag is close to conclusive - Markdown
 * can contain raw HTML, but a document opening with `<div>` or `<table>` is
 * being written as HTML. Markdown's signals are checked next, because they are
 * syntax HTML has no equivalent of. Anything else falls through to Markdown as
 * the assumption, since Markdown is a superset of plain prose: converting a
 * paragraph of text as Markdown returns the paragraph, whereas parsing it as
 * HTML would too, but says something false about what it is.
 */
export function detectFormat(source: string): Detection {
  const trimmed = source.trim();

  if (trimmed === '') {
    return { format: 'markdown', confidence: 'assumed', reason: 'The input is empty.' };
  }

  const htmlTag = STRUCTURAL_TAG.exec(trimmed);
  const markdownSignal = MARKDOWN_SIGNALS.find((signal) => signal.pattern.test(trimmed));

  /*
   * Both kinds of evidence. This is the genuinely ambiguous case - a Markdown
   * document with an HTML block in it, or an HTML document with a stray `**`.
   * It is resolved on where the HTML starts: markup at the very beginning is
   * a document, markup further down is an embedded block inside Markdown. The
   * confidence is lowered either way, so the UI says it was a judgement call.
   */
  if (htmlTag && markdownSignal) {
    const atStart = trimmed.toLowerCase().startsWith(htmlTag[0].toLowerCase());
    return atStart
      ? {
          format: 'html',
          confidence: 'assumed',
          reason: `Starts with ${htmlTag[0].slice(0, 24)}, but also contains ${markdownSignal.what}.`,
        }
      : {
          format: 'markdown',
          confidence: 'assumed',
          reason: `Contains ${markdownSignal.what} and some embedded HTML.`,
        };
  }

  if (htmlTag) {
    return {
      format: 'html',
      confidence: 'confident',
      reason: `Found the HTML tag ${htmlTag[0].slice(0, 24)}.`,
    };
  }

  if (markdownSignal) {
    return {
      format: 'markdown',
      confidence: 'confident',
      reason: `Found ${markdownSignal.what}.`,
    };
  }

  return {
    format: 'markdown',
    confidence: 'assumed',
    reason:
      'No markup and no Markdown syntax found; treating it as Markdown, which leaves plain prose unchanged.',
  };
}
