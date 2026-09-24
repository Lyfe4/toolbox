#!/usr/bin/env node
/**
 * Captures what a browser's own serialiser puts on the clipboard, for the
 * pasted-HTML corpus.
 *
 * WHY THIS EXISTS. The corpus is there because the census notes on
 * text-convert were swept for nine rounds against HTML that cmark wrote, and
 * cmark writes exactly the vocabulary this tool's pipeline emits - so the one
 * input class that produces a false note was the one class the sweep could not
 * contain. Hand-written documents are half of the fix. This is the other half:
 * HTML that a MACHINE other than ours wrote, which is what arrives when
 * somebody copies from a page and pastes the source.
 *
 * WHAT IT DOES. It serves four small pages of its own - nothing is fetched
 * from anywhere - selects the page's content, presses a real Ctrl+C and reads
 * the clipboard back through navigator.clipboard.read(). Chromium and Firefox
 * only: WebKit's async clipboard hands a read no items in Playwright's build,
 * measured when this was written, so there is no WebKit entry rather than one
 * made up to look like it.
 *
 * WHAT IT IS NOT. navigator.clipboard.read() returns the engine's sanitised
 * reading of the clipboard, and a native paste on Windows also carries the
 * CF_HTML header and StartFragment comments. The markup between them is the
 * serialiser's, which is the part a person pastes.
 *
 * Rewrites the `clipboard` entries of the corpus in place and leaves every
 * other entry as it was:
 *
 *     node scripts/capture-pasted-html.mjs && pnpm exec prettier --write src/tools/text-convert/spec/pasted-html.corpus.json
 *
 * Then regenerate the oracle - see scripts/generate-pasted-html-oracle.mjs.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';

import { chromium, firefox } from 'playwright';

const CORPUS = new URL('../src/tools/text-convert/spec/pasted-html.corpus.json', import.meta.url);

const STYLE = `
  body { font-family: Georgia, serif; color: #222; max-width: 40rem; }
  .author { color: #8a4b00; font-weight: 600; }
  .kw { color: #7a1fa2; font-weight: bold; }
  .str { color: #1a7f37; }
  .code { background: #f6f8fa; padding: 12px; }
  th { background: #eee; text-align: left; }
  .muted { color: #666; }
`;

/** Each page, and the words that say what it is a page of. */
const PAGES = [
  {
    id: 'blog-post',
    about:
      'A styled article: a heading, a paragraph with emphasis, a link and a classed span, and a list.',
    body: '<h2>Release notes</h2><p>This week we <em>finally</em> shipped the <a href="https://example.com/importer">new importer</a>. Thanks to <span class="author">Ana</span> for most of it.</p><ul><li>Faster</li><li>Smaller</li></ul>',
  },
  {
    id: 'highlighted-code',
    about:
      'Two highlighted code blocks, one with a <code> inside its <pre> and one without, as highlighters write both.',
    body: '<p>Add them up:</p><pre class="code"><code><span class="kw">function</span> add(a, b) {\n  <span class="kw">return</span> a + b;\n}</code></pre><pre class="code"><span class="kw">const</span> name = <span class="str">"patchbay"</span>;</pre>',
  },
  {
    id: 'data-table',
    about: 'A data table with a header row, and a muted note under it.',
    body: '<table><thead><tr><th>Region</th><th>Sales</th></tr></thead><tbody><tr><td>North</td><td>3</td></tr><tr><td>South</td><td>5</td></tr></tbody></table><p class="muted">Figures are in thousands.</p>',
  },
  {
    id: 'docs-page',
    about: 'A documentation page: a heading, inline code, a quotation and a nested list.',
    body: '<h1>Configuration</h1><p>Set <code>port</code> in the config file.</p><blockquote><p>Defaults are fine for most people.</p></blockquote><ol><li>Open the file<ul><li>it is in the root</li></ul></li><li>Save it</li></ol>',
  },
];

const server = createServer((request, response) => {
  const page = PAGES.find((candidate) => request.url === `/${candidate.id}`);
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(
    page
      ? `<!doctype html><html lang="en"><title>${page.id}</title><style>${STYLE}</style><body><main>${page.body}</main></body></html>`
      : '<!doctype html><title>none</title>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const origin = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;

const ENGINES = [
  // Chromium needs the permission granted; Firefox's build does not know the
  // name and throws on it, and allows a read after a trusted copy anyway.
  ['chromium', chromium, { permissions: ['clipboard-read', 'clipboard-write'] }],
  ['firefox', firefox, {}],
];

const captured = [];

for (const [name, engine, contextOptions] of ENGINES) {
  const browser = await engine.launch();
  const version = browser.version();
  try {
    for (const page of PAGES) {
      const context = await browser.newContext(contextOptions);
      const tab = await context.newPage();
      await tab.goto(`${origin}/${page.id}`);
      await tab.evaluate(() => {
        const main = document.querySelector('main');
        if (!main) throw new Error('no main');
        const range = document.createRange();
        range.selectNodeContents(main);
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      await tab.keyboard.press('Control+C');
      const html = await tab.evaluate(async () => {
        const [item] = await navigator.clipboard.read();
        if (!item?.types.includes('text/html')) return null;
        return (await item.getType('text/html')).text();
      });
      await context.close();
      if (html === null)
        throw new Error(`${name} put no text/html on the clipboard for ${page.id}`);
      captured.push({
        id: `${name}-copy-${page.id}`,
        kind: 'clipboard',
        engine: `${name} ${version}`,
        html,
        about: page.about,
      });
    }
  } finally {
    await browser.close();
  }
}

server.close();

const corpus = JSON.parse(await readFile(CORPUS, 'utf8'));
corpus.documents = [
  ...corpus.documents.filter((document) => document.kind !== 'clipboard'),
  ...captured,
];
await writeFile(CORPUS, `${JSON.stringify(corpus, null, 2)}\n`);
console.log(`captured ${String(captured.length)} documents`);
