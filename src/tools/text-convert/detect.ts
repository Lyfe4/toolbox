/** The formats this tool can read. Plain text is a target only - see README. */
export const SOURCE_FORMATS = ['markdown', 'html'] as const;
export type SourceFormat = (typeof SOURCE_FORMATS)[number];

/**
 * TWO HTML TARGETS, BECAUSE THEY ARE TWO OPERATIONS.
 *
 * `html` is the normalising pass: an HTML source goes out to Markdown and back,
 * which is what makes it come back tidy - and which bounds it by what Markdown
 * can express. Measured: `<img width>` goes, a `<div>` is unwrapped, a
 * `colspan` becomes an empty cell, and a headerless `<table>` GAINS AN EMPTY
 * HEADER ROW that was never in the input. It was called "HTML" and it was the
 * only choice, so the two halves - sanitising, which everybody wants, and
 * normalising, which invents - could not be had separately.
 *
 * `html-sanitised` is the other half on its own: the sanitiser and nothing
 * else. Nothing is invented, and nothing that only Markdown cannot express is
 * lost, because Markdown is not involved.
 *
 * IT IS NOT "LOSE NOTHING", and measuring is what said so: `class` and `data-*`
 * are removed by the ALLOW-LIST, in both targets. The matrix had them under the
 * round trip, which would have told somebody that switching target keeps them.
 * Each half reports its own removals for that reason.
 *
 * `html` KEEPS ITS VALUE rather than becoming `html-normalised`. Target names
 * travel in saved canvases and in share links, and a renamed value silently
 * drops back to the default - so every existing link would quietly start doing
 * something else. The new capability is the new name.
 *
 * FROM A MARKDOWN SOURCE THE TWO COINCIDE, and they have to: HTML produced from
 * Markdown has already been through Markdown, so there is no round trip left to
 * make. The option's own description says so, which is the same bargain the
 * `output`/`rendered` coincidence strikes.
 */
export const TARGET_FORMATS = ['markdown', 'html', 'html-sanitised', 'text'] as const;
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

/**
 * A fenced code block, opening fence to closing fence or to the end.
 *
 * The closing fence is matched through the backreference, so a four-backtick
 * block holding a three-backtick one is a single block rather than two.
 *
 * `(?![\s\S])` rather than `$` for "or to the end". Under the `m` flag `$`
 * matches at the end of every LINE, so the alternation was satisfied one line
 * into the block and the fence's contents were only removed by accident of
 * where the match happened to stop - which held for a plain fence and did not
 * for a nested one.
 */
const FENCED_BLOCK = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm;

/**
 * An inline code span: a run of backticks, its contents, and a matching run.
 *
 * A code span cannot contain a blank line, and saying so is what stops a
 * stray backtick near the top of a document from swallowing everything down
 * to the next one several paragraphs later.
 */
const CODE_SPAN = /(`+)(?:(?!\n[ \t]*\n)[\s\S])*?\1/g;

/**
 * The document with everything Markdown reads as code blanked out.
 *
 * ONLY THE HTML SEARCH USES THIS, and that asymmetry is the point: a fence is
 * itself a Markdown signal, so the signals below are still looked for in the
 * document as written.
 *
 * Without it, `Use \`<div>\` here.` - a sentence about HTML, which is most of
 * what an LLM writes about HTML - was reported as HTML with CONFIDENCE. The
 * converter then read the code span's contents as markup: the backticks became
 * literal text and the element they quoted was parsed, so a paragraph came
 * back with the one thing it was about missing from it. Nothing failed, and
 * "confident" is exactly what stops the reader checking the source control.
 */
function withoutCode(source: string): string {
  return source.replace(FENCED_BLOCK, '').replace(CODE_SPAN, '');
}

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

  const htmlTag = STRUCTURAL_TAG.exec(withoutCode(trimmed));
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
