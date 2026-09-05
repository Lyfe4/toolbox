/**
 * WHAT ACTUALLY GOES ON THE CLIPBOARD.
 *
 * Two flavours are written together, and both were wrong before this existed.
 *
 * THE HTML FLAVOUR WAS UNSTYLED. It was the tool's sanitised output verbatim:
 * a bare `<table>` with no attributes, `<pre>` with no background, `<code>`
 * with no monospace. Pasted into Word that is a borderless grid of text, which
 * is the single most-reported way a rich-text paste disappoints.
 *
 * A stylesheet does not solve it. Google Docs discards `<style>` blocks
 * outright, and Outlook's Word engine ignores most of what it does not
 * recognise; the one thing all three honour is an inline `style` attribute on
 * the element itself. So the clipboard document carries its styling inline -
 * the opposite choice from the preview, which uses one hashed stylesheet
 * because a `style` attribute is what its CSP refuses.
 *
 * THE PLAIN FLAVOUR WAS THE HTML SOURCE. `copyRichText(html, html)` - so an
 * application that asked for `text/plain`, which is most of them, got a wall
 * of angle brackets. It is now a readable text rendering of the same content.
 *
 * NO INNERHTML ANYWHERE. Parsing uses DOMParser, which builds an inert
 * document with no browsing context: scripts do not run and subresources are
 * not fetched. Serialising is done by the walker below rather than by reading
 * `outerHTML`, which the project bans outright. The input is already
 * sanitised - this module never sees anything the allow-list has not passed.
 */

/** Inline styling per element, applied on the way out to the clipboard. */
const STYLES: Readonly<Record<string, string>> = {
  /*
   * `border-collapse` on the table and a border on every cell. Word will
   * otherwise draw nothing at all, which is the borderless paste people
   * complain about.
   */
  table: 'border-collapse:collapse;margin:0 0 12px',
  th: 'border:1px solid #d1d9e0;padding:6px 13px;background-color:#f6f8fa;font-weight:600;text-align:left',
  td: 'border:1px solid #d1d9e0;padding:6px 13px',
  caption: 'margin-bottom:6px;font-size:0.9em;color:#59636e;text-align:left',

  pre: 'background-color:#f6f8fa;padding:12px;border-radius:6px;font-family:Consolas,Monaco,monospace;font-size:0.9em;white-space:pre-wrap;margin:0 0 12px',
  code: 'font-family:Consolas,Monaco,monospace;font-size:0.9em',

  blockquote:
    'border-left:4px solid #d1d9e0;padding-left:12px;margin:0 0 12px;color:#59636e;font-style:normal',

  h1: 'font-size:1.9em;font-weight:600;margin:20px 0 10px',
  h2: 'font-size:1.45em;font-weight:600;margin:20px 0 10px',
  h3: 'font-size:1.2em;font-weight:600;margin:18px 0 8px',
  h4: 'font-size:1em;font-weight:600;margin:16px 0 8px',
  h5: 'font-size:0.9em;font-weight:600;margin:16px 0 8px',
  h6: 'font-size:0.85em;font-weight:600;margin:16px 0 8px;color:#59636e',

  a: 'color:#0969da',
  hr: 'border:0;border-top:1px solid #d1d9e0;margin:20px 0',
  img: 'max-width:100%',
  del: 'color:#59636e',
  mark: 'background-color:#fff8c5',
  small: 'font-size:0.85em;color:#59636e',
  figcaption: 'font-size:0.9em;color:#59636e',
  dt: 'font-weight:600;font-style:italic;margin-top:12px',
  dd: 'margin:0 0 12px 24px',
  kbd: 'font-family:Consolas,Monaco,monospace;font-size:0.9em;border:1px solid #d1d9e0;border-radius:4px;padding:1px 4px;background-color:#f6f8fa',
  abbr: 'border-bottom:1px dotted #59636e',
  summary: 'font-weight:600',
};

/** Elements written without a closing tag. */
const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'input', 'col', 'wbr']);

/** Elements whose text is content and must not be reflowed. */
const VERBATIM = new Set(['pre', 'code']);

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/**
 * The style an element gets, with the table alignment attribute folded in.
 *
 * GFM writes column alignment onto every cell as `align="right"`, and Word
 * honours the attribute - but Google Docs does not, so the alignment has to
 * become a declaration as well or half the targets lose it.
 */
function styleFor(element: Element): string {
  const base = STYLES[element.tagName.toLowerCase()] ?? '';
  const align = element.getAttribute('align');
  const alignment = align === null || align === '' ? '' : `text-align:${align}`;

  return [base, alignment].filter((part) => part !== '').join(';');
}

function serialise(node: Node, inVerbatim: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  const verbatim = inVerbatim || VERBATIM.has(tag);

  const attributes: string[] = [];
  for (const attribute of element.attributes) {
    // The style we are about to write wins over anything already there;
    // sanitised output carries none, but this is not the place to find out.
    if (attribute.name === 'style') continue;
    attributes.push(`${attribute.name}="${escapeAttribute(attribute.value)}"`);
  }

  const style = styleFor(element);
  if (style !== '') attributes.push(`style="${escapeAttribute(style)}"`);

  /*
   * Legacy table attributes alongside the CSS. Outlook's engine ignores
   * border declarations in a pasted document often enough that the attribute
   * is the only thing keeping the grid visible there; `border-collapse`
   * stops the two doubling up anywhere else.
   */
  if (tag === 'table') attributes.push('border="1"', 'cellspacing="0"', 'cellpadding="6"');

  const open = `<${tag}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}>`;
  if (VOID_ELEMENTS.has(tag)) return open;

  const inner = [...element.childNodes].map((child) => serialise(child, verbatim)).join('');
  return `${open}${inner}</${tag}>`;
}

/**
 * The `text/html` flavour: a complete document, styled inline.
 *
 * A full `<html>` wrapper with a charset rather than a fragment, because Word
 * and Outlook both read the clipboard payload as a document and will guess an
 * encoding if none is declared - which is how an em dash becomes three
 * characters of mojibake.
 */
export function richTextDocument(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const body = [...parsed.body.childNodes].map((child) => serialise(child, false)).join('');

  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head>',
    '<body style="font-family:Calibri,Segoe UI,Arial,sans-serif;font-size:11pt;color:#1f2328">',
    body,
    '</body></html>',
  ].join('');
}

/* ========================================================================== *
 * The plain-text flavour
 * ========================================================================== */

const BLOCK = new Set([
  'p',
  'div',
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
  'table',
  'section',
  'figure',
  'dl',
  'details',
]);

/**
 * A readable text rendering, mirroring the policies in `htmlToText`.
 *
 * Deliberately a separate implementation rather than an import: `htmlToText`
 * lives in the markup pipeline, which is a 419 kB chunk that runs in the
 * worker, and pulling it into the main thread to service a copy button would
 * cost more than the button is worth. The policies it mirrors - heading
 * markers, real list numbers, checkbox state, indented code - are asserted
 * side by side in the tests so the two cannot drift silently.
 */
/**
 * Adds text to the line being built.
 *
 * A task item's text begins with the space that separated it from its
 * checkbox in the HTML, and the marker already ends with one - so without the
 * collapse here every checkbox came out as "[x]  done".
 */
function append(lines: string[], value: string): void {
  const index = lines.length - 1;
  const current = lines[index] ?? '';
  lines[index] = current + (current.endsWith(' ') ? value.replace(/^ /, '') : value);
}

function textOf(node: Node, depth: number, lines: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.nodeValue ?? '';
    if (value.trim() === '') return;

    append(lines, value.replace(/\s+/g, ' '));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  const children = [...element.childNodes];
  const indent = '  '.repeat(depth);

  if (tag === 'br') {
    lines.push(indent);
    return;
  }

  if (tag === 'hr') {
    lines.push('', '---', '');
    return;
  }

  if (tag === 'img') {
    const alt = element.getAttribute('alt');
    if (alt !== null && alt !== '') append(lines, alt);
    return;
  }

  if (/^h[1-6]$/.test(tag)) {
    lines.push('', `${'#'.repeat(Number(tag.slice(1)))} `);
    for (const child of children) textOf(child, depth, lines);
    lines.push('');
    return;
  }

  if (tag === 'pre') {
    lines.push('');
    for (const line of element.textContent.replace(/\n$/, '').split('\n')) {
      lines.push(`${indent}    ${line}`);
    }
    lines.push('');
    return;
  }

  if (tag === 'li') {
    const parent = element.parentElement;
    const ordered = parent?.tagName.toLowerCase() === 'ol';
    const index = parent ? [...parent.children].indexOf(element) : 0;
    const start = Number(parent?.getAttribute('start') ?? '1');
    const marker = ordered ? `${String(start + index)}. ` : '- ';

    const box = element.querySelector(':scope > input[type="checkbox"]');
    const state = box === null ? '' : box.hasAttribute('checked') ? '[x] ' : '[ ] ';

    lines.push(`${indent}${marker}${state}`);
    for (const child of children) textOf(child, depth + 1, lines);
    return;
  }

  if (tag === 'input') return;

  if (tag === 'blockquote') {
    const inner: string[] = [''];
    for (const child of children) textOf(child, 0, inner);
    lines.push('');
    for (const line of inner) lines.push(`${indent}> ${line}`.trimEnd());
    lines.push('');
    return;
  }

  if (tag === 'tr') {
    const cells = [...element.children].map((cell) => cell.textContent.replace(/\s+/g, ' ').trim());
    lines.push(cells.join(' | '));
    return;
  }

  if (tag === 'a') {
    const href = element.getAttribute('href') ?? '';
    const text = element.textContent.replace(/\s+/g, ' ').trim();
    append(
      lines,
      href === '' || href === text || href === `mailto:${text}` ? text : `${text} (${href})`,
    );
    return;
  }

  if (tag === 'ul' || tag === 'ol') {
    for (const child of children) textOf(child, depth, lines);
    if (depth === 0) lines.push('');
    return;
  }

  if (BLOCK.has(tag)) {
    lines.push(indent);
    for (const child of children) textOf(child, depth, lines);
    lines.push('');
    return;
  }

  for (const child of children) textOf(child, depth, lines);
}

/** The `text/plain` flavour: the same content, readable without markup. */
export function richTextPlain(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const lines: string[] = [''];
  for (const child of parsed.body.childNodes) textOf(child, 0, lines);

  return lines
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
