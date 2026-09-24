#!/usr/bin/env node
/**
 * Asks three real engines whether a reader can SEE what the census says
 * happened, for every document in the pasted-HTML corpus, and commits the
 * answers.
 *
 * THE QUESTION. text-convert's census compares element NAMES in two documents
 * and its notes make claims about CONTENT: "could not carry", "was invented".
 * Round fifteen found three notes shipping that fire when a reader can see no
 * difference at all. This script is the reference those notes are held to, and
 * it does not read the census: it renders the documents and compares what the
 * engines drew.
 *
 * WHAT IT MEASURES, per document, in Chromium, Firefox and WebKit:
 *
 *   sanitiser   the input against the sanitised hub (what the allow-list did)
 *   roundTrip   the sanitised hub against the normalised output (what the
 *               Markdown round trip did - the HTML target's output, and the
 *               document the Markdown target's `rendered` port carries)
 *
 * each as two answers: can a reader SEE a difference, and is the
 * ACCESSIBILITY TREE identical (Playwright's aria snapshot, which is its own
 * implementation of the role and name computation, not this repository's).
 * And:
 *
 *   unwrapped   for every element name whose count differs between the hub
 *               and the output, the document that has MORE of them with every
 *               one of them unwrapped - children kept, the element gone - and
 *               whether a reader could tell it from the document as it is.
 *               If taking every `<code>` out of the output changes nothing
 *               anybody can see, then a `<code>` the round trip added is not
 *               something a reader can see, whatever its name says.
 *
 * "CAN SEE", DEFINED, BECAUSE PIXEL IDENTITY WAS WRONG BOTH WAYS. The first
 * version compared screenshots byte for byte, and Chromium redraws a glyph at
 * a fractional offset wherever an element boundary restarts a text run: 21
 * pixels of one "1", which no reader could see, called a loss. A count of
 * differing pixels cannot separate that from a strike line through a word,
 * which is 16. So a difference is visible when EITHER of two things says so:
 *
 *   ink        channel by channel, a pixel of ink in one picture with no ink
 *              within one pixel of it in the other - which forgives a glyph
 *              that moved by a fraction of a pixel, and nothing else;
 *   layout     any visible character whose box the engine placed more than a
 *              pixel away, or whose computed style a reader sees it in -
 *              colour, font, weight, slant, decoration from every ancestor,
 *              background - differs; or a replaced box that moved.
 *
 * Ink alone is too kind: WebKit's strike through "old" lies within a pixel of
 * the letters it crosses, and ink passed it. Layout alone cannot see a list
 * marker, a quotation mark or an image. CALIBRATED BEFORE IT IS USED: twelve
 * pairs every engine must see (one bold letter, a strike, a dotted underline,
 * a colour, a comma for a full stop, quotation marks...) and three it must not
 * (the three false notes round fifteen found), in all three engines, or the
 * script refuses to write an oracle. The calibration is committed, and the
 * test asserts it rather than trusting this log.

 * Rendered under each engine's own UA stylesheet and nothing else, at a fixed
 * 800 x 600 viewport, full page, with scripts off and every request refused.
 * The UA stylesheet is the reference the respelling filter already rests on
 * (the HTML Standard's rendering section), and it is what a pasted document
 * gets wherever no stylesheet has been written for it.
 *
 * WHAT IT CANNOT SEE, SAID HERE SO IT IS NOT MISTAKEN FOR MORE. A class or an
 * attribute that nothing styles renders as nothing, so the pixels cannot judge
 * an ATTRIBUTE note - a lost `class` is a real loss to whoever had a
 * stylesheet for it. The attribute, class-name and identifier notes are
 * therefore not held to this oracle, only the two ELEMENT notes are.
 *
 * A SELF-CHECK BEFORE ANY ANSWER IS BELIEVED. Every engine renders every
 * document twice and the two screenshots, layouts and accessibility trees must
 * be identical; an engine that does not draw the same page the same way twice
 * would make every "same" in the fixture a coin toss, so the script refuses to
 * write one.
 *
 * TIED TO THE BYTES. Each entry carries the sanitised and normalised documents
 * the tool produced, and the test checks the tool still produces them before it
 * believes the verdict beside them - a changed pipeline is a red test telling
 * you to regenerate, not a stale verdict.
 *
 *     node scripts/generate-pasted-html-oracle.mjs && pnpm exec prettier --write src/tools/text-convert/spec/pasted-html.oracle.json
 *
 * Needs Chromium, Firefox and WebKit (`pnpm exec playwright install`); nothing
 * at test time does.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'vite';

const ROOT = new URL('..', import.meta.url);
const CORPUS = new URL('src/tools/text-convert/spec/pasted-html.corpus.json', ROOT);
const ORACLE = new URL('src/tools/text-convert/spec/pasted-html.oracle.json', ROOT);

/* ========================================================================== *
 * The tool, loaded the way the app loads it
 * ========================================================================== */

const server = await createServer({
  configFile: false,
  resolve: { alias: { '@': fileURLToPath(new URL('src', ROOT)) } },
  server: { middlewareMode: true },
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
});

const { default: tool } = await server.ssrLoadModule('/src/tools/text-convert/index.ts');

async function convert(html, target) {
  const result = await tool.run({
    inputs: { input: { type: 'text', text: html } },
    options: { source: 'html', target },
    context: { signal: new AbortController().signal },
  });
  if (!result.ok) throw new Error(`${target}: ${result.error.message}`);
  const text = (port) => {
    const value = result.value[port];
    if (value?.type !== 'text') throw new Error(`${target}: no ${port} text`);
    return value.text;
  };
  return { output: text('output'), rendered: text('rendered') };
}

/* ========================================================================== *
 * The engines
 * ========================================================================== */

const ENGINES = [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
];

const VIEWPORT = { width: 800, height: 600 };

/**
 * Removes every element with this tag name and keeps its children in its
 * place. Run in the page, on a parsed copy, so the engine's own parser decides
 * what the markup is.
 */
function unwrapIn(html, tag) {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const element of [...template.content.querySelectorAll(tag)]) {
    element.replaceWith(...element.childNodes);
  }
  return template.innerHTML;
}

/*
 * THE OTHER HALF OF "VISIBLE", read from the engine's own layout.
 *
 * Ink proximity forgives a glyph that moved by a fraction of a pixel, which is
 * the point of it - and it forgives a one-pixel line drawn through the middle
 * of a word for the same reason, measured: WebKit's strike through "old" is
 * sixteen pixels, every one of them within a pixel of letter ink. So each
 * visible character is also compared by where the engine put it (to within a
 * pixel, which is the same tolerance) and by the computed style a reader sees
 * it in. Decoration is collected from every ancestor, because it propagates to
 * the text without being inherited: `<s><b>x</b></s>` computes `none` on the
 * `<b>`.
 *
 * Run in the page with scripts off, through Playwright's evaluate.
 */
function layoutOf() {
  const round = (value) => Math.round(value);
  const styleOf = (element) => {
    const style = getComputedStyle(element);
    const decoration = new Set();
    let background = 'transparent';
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const own = getComputedStyle(node);
      for (const line of own.textDecorationLine.split(' '))
        if (line !== 'none') decoration.add(line);
      const fill = own.backgroundColor;
      if (background === 'transparent' && fill !== 'rgba(0, 0, 0, 0)' && fill !== 'transparent')
        background = fill;
    }
    return [
      style.color,
      style.fontFamily,
      style.fontSize,
      style.fontWeight,
      style.fontStyle,
      [...decoration].sort().join('+'),
      background,
      style.visibility,
    ].join('|');
  };

  const characters = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const parent = text.parentElement;
    if (!parent) continue;
    const style = styleOf(parent);
    for (let index = 0; index < text.data.length; index += 1) {
      const character = text.data[index];
      if (character.trim() === '') continue;
      const range = document.createRange();
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      characters.push([
        character,
        round(rect.x),
        round(rect.y),
        round(rect.width),
        round(rect.height),
        style,
      ]);
    }
  }

  const boxes = [];
  for (const element of document.body.querySelectorAll(
    'img, hr, input, svg, video, audio, iframe, canvas, object',
  )) {
    const rect = element.getBoundingClientRect();
    boxes.push([round(rect.x), round(rect.y), round(rect.width), round(rect.height)]);
  }

  return { characters, boxes };
}

/** The first way two layouts differ by more than a pixel, or null. */
function layoutDifference(first, second) {
  const close = (a, b) => Math.abs(a - b) <= 1;
  if (first.characters.length !== second.characters.length) {
    return `${String(first.characters.length)} visible characters against ${String(second.characters.length)}`;
  }
  for (let index = 0; index < first.characters.length; index += 1) {
    const [c, x, y, w, h, style] = first.characters[index];
    const [d, u, v, s, t, other] = second.characters[index];
    if (c !== d) return `character ${String(index)}: ${c} against ${d}`;
    if (!close(x, u) || !close(y, v) || !close(w, s) || !close(h, t)) {
      return `${c} at ${String(index)} moved: ${[x, y, w, h].join(',')} against ${[u, v, s, t].join(',')}`;
    }
    if (style !== other) return `${c} at ${String(index)}: ${style} against ${other}`;
  }
  if (first.boxes.length !== second.boxes.length) return 'a different number of replaced boxes';
  for (let index = 0; index < first.boxes.length; index += 1) {
    if (!first.boxes[index].every((value, axis) => close(value, second.boxes[index][axis]))) {
      return `replaced box ${String(index)} moved`;
    }
  }
  return null;
}

async function openEngine(name, engine) {
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, javaScriptEnabled: false });
  await context.route('**/*', (route) => route.abort());
  const page = await context.newPage();

  const shot = async (html) => {
    await page.setContent(`<!doctype html><html lang="en"><body>${html}</body></html>`, {
      waitUntil: 'load',
    });
    return {
      pixels: await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' }),
      aria: await page.locator('body').ariaSnapshot(),
      layout: await page.evaluate(`(${layoutOf.toString()})()`),
    };
  };

  /*
   * A second page, with scripts ON, that only ever decodes two screenshots and
   * counts the pixels that differ. The rendering page keeps scripts off; the
   * decoder is the engine's own image decoder and canvas, so nothing in this
   * repository has to parse a PNG.
   */
  const diffContext = await browser.newContext();
  const diffPage = await diffContext.newPage();
  await diffPage.setContent('<!doctype html><title>diff</title>');

  const differingPixels = async (a, b) => {
    if (a.equals(b)) return { count: 0, box: null, unexplained: 0 };
    return diffPage.evaluate(
      async ([first, second]) => {
        const load = (data) =>
          new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = reject;
            image.src = `data:image/png;base64,${data}`;
          });
        const [one, two] = await Promise.all([load(first), load(second)]);
        const width = Math.max(one.width, two.width);
        const height = Math.max(one.height, two.height);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const pixelsOf = (image) => {
          context.clearRect(0, 0, width, height);
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, width, height).data;
        };
        const p = pixelsOf(one);
        const q = pixelsOf(two);

        /*
         * INK THAT MOVED BY LESS THAN A PIXEL, and nothing else. Each channel
         * is thresholded into ink and paper, and a pixel of ink in one image
         * is explained when the other has ink in the same channel within one
         * pixel of it. What is left is ink that is new, gone or moved further
         * than a glyph re-rasterised at a fractional offset can move.
         */
        const unexplained = (() => {
          let total = 0;
          for (let channel = 0; channel < 3; channel += 1) {
            const inked = (data, x, y) =>
              x >= 0 &&
              y >= 0 &&
              x < width &&
              y < height &&
              data[(y * width + x) * 4 + channel] < 128;
            const near = (data, x, y) => {
              for (let dy = -1; dy <= 1; dy += 1)
                for (let dx = -1; dx <= 1; dx += 1) if (inked(data, x + dx, y + dy)) return true;
              return false;
            };
            for (let y = 0; y < height; y += 1)
              for (let x = 0; x < width; x += 1) {
                if (inked(p, x, y) && !near(q, x, y)) total += 1;
                if (inked(q, x, y) && !near(p, x, y)) total += 1;
              }
          }
          return total;
        })();

        let count = 0;
        let box = null;
        for (let index = 0; index < p.length; index += 4) {
          if (
            p[index] === q[index] &&
            p[index + 1] === q[index + 1] &&
            p[index + 2] === q[index + 2] &&
            p[index + 3] === q[index + 3]
          )
            continue;
          count += 1;
          const x = (index / 4) % width;
          const y = Math.floor(index / 4 / width);
          box = box
            ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)]
            : [x, y, x, y];
        }
        return { count, box, unexplained };
      },
      [a.toString('base64'), b.toString('base64')],
    );
  };

  const compare = async (first, second) => {
    const a = await shot(first);
    const b = await shot(second);
    const diff = await differingPixels(a.pixels, b.pixels);
    const layoutDiffers = layoutDifference(a.layout, b.layout);
    return {
      visible: diff.unexplained > 0 || layoutDiffers !== null,
      layoutDiffers,
      differingPixels: diff.count,
      unexplainedPixels: diff.unexplained,
      box: diff.box,
      sameAccessibilityTree: a.aria === b.aria,
    };
  };

  const unwrap = async (html, tag) => {
    await page.setContent('<!doctype html><title>scratch</title>');
    return page.evaluate(
      `(${unwrapIn.toString()})(${JSON.stringify(html)}, ${JSON.stringify(tag)})`,
    );
  };

  const counts = async (html) => {
    await page.setContent('<!doctype html><title>scratch</title>');
    return page.evaluate(`(() => {
      const template = document.createElement('template');
      template.innerHTML = ${JSON.stringify(html)};
      const counts = {};
      for (const element of template.content.querySelectorAll('*')) {
        const tag = element.localName;
        counts[tag] = (counts[tag] ?? 0) + 1;
      }
      return counts;
    })()`);
  };

  return {
    name,
    version: browser.version(),
    shot,
    compare,
    unwrap,
    counts,
    close: () => browser.close(),
  };
}

/* ========================================================================== *
 * The run
 * ========================================================================== */

/*
 * THE RULE, CALIBRATED BEFORE IT IS USED. "Ink within one pixel" is a
 * definition, and a definition can be wrong in either direction: too loose and
 * it forgives a real change, too tight and it calls a re-rasterised glyph a
 * loss. So every engine must get each of these right before any corpus
 * document is judged, and the script refuses to write an oracle otherwise.
 *
 * The SEEN pairs are the smallest real changes the census has to report - one
 * bold letter, a strike through three, a dotted underline, a colour, a comma
 * for a full stop. The UNSEEN pairs are the three false notes round fifteen
 * found, which is the direction a loose rule would be kind to.
 */
const CALIBRATION = {
  seen: [
    ['<p>I</p>', '<p><b>I</b></p>'],
    ['<p>word</p>', '<p><i>word</i></p>'],
    ['<p>old</p>', '<p><s>old</s></p>'],
    ['<p>word</p>', '<p><u>word</u></p>'],
    ['<p>HTML</p>', '<p><abbr title="HyperText">HTML</abbr></p>'],
    ['<p>E = mc2</p>', '<p>E = mc<sup>2</sup></p>'],
    ['<p>word</p>', '<p><font color="#c00000">word</font></p>'],
    ['<p>word</p>', '<p><mark>word</mark></p>'],
    ['<p>word</p>', '<p><a href="https://example.com">word</a></p>'],
    ['<p>a.</p>', '<p>a,</p>'],
    ['<p>not today</p>', '<p><q>not today</q></p>'],
    ['<div>one</div><div>two</div>', '<p>one</p><p>two</p>'],
  ],
  unseen: [
    ['<p>a <span>plain</span> word</p>', '<p>a plain word</p>'],
    ['<pre>one\ntwo</pre>', '<pre><code>one\ntwo\n</code></pre>'],
    ['<div><p>inside</p></div>', '<p>inside</p>'],
  ],
};

const corpus = JSON.parse(await readFile(CORPUS, 'utf8'));
const engines = [];
for (const [name, engine] of ENGINES) engines.push(await openEngine(name, engine));

const calibration = [];
for (const engine of engines) {
  for (const [expected, pairs] of [
    [true, CALIBRATION.seen],
    [false, CALIBRATION.unseen],
  ]) {
    for (const [first, second] of pairs) {
      const { visible, differingPixels, unexplainedPixels, layoutDiffers } = await engine.compare(
        first,
        second,
      );
      calibration.push({
        engine: engine.name,
        pair: [first, second],
        expected: expected ? 'seen' : 'unseen',
        byInk: unexplainedPixels > 0,
        byLayout: layoutDiffers !== null,
      });
      if (visible !== expected) {
        for (const other of engines) await other.close();
        await server.close();
        throw new Error(
          `${engine.name} calls ${first} against ${second} ${visible ? 'visible' : 'invisible'} (${String(differingPixels)} pixels differ); the rule is miscalibrated, refusing to write an oracle`,
        );
      }
    }
  }
}

const entries = [];

try {
  for (const document of corpus.documents) {
    const sanitised = (await convert(document.html, 'html-sanitised')).output;
    const normalised = (await convert(document.html, 'html')).output;
    const markdown = await convert(document.html, 'markdown');
    if (markdown.rendered !== normalised) {
      throw new Error(
        `${document.id}: the Markdown target's rendered port is not the HTML target's output, so one oracle cannot stand for both targets`,
      );
    }

    const sanitiser = {};
    const roundTrip = {};
    const unwrapped = {};

    for (const engine of engines) {
      // The self-check: the same document twice must be the same picture.
      for (const html of [document.html, sanitised, normalised]) {
        const again = await engine.compare(html, html);
        if (
          again.differingPixels !== 0 ||
          !again.sameAccessibilityTree ||
          again.layoutDiffers !== null
        ) {
          throw new Error(
            `${engine.name} drew ${document.id} differently twice; refusing to write an oracle`,
          );
        }
      }

      sanitiser[engine.name] = await engine.compare(document.html, sanitised);
      roundTrip[engine.name] = await engine.compare(sanitised, normalised);

      const before = await engine.counts(sanitised);
      const after = await engine.counts(normalised);
      for (const tag of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const had = before[tag] ?? 0;
        const has = after[tag] ?? 0;
        if (had === has) continue;
        // Unwrap it in whichever document has more of it, and ask whether
        // the element's presence there is something a reader can see.
        const direction = had > has ? 'fewer' : 'more';
        const subject = had > has ? sanitised : normalised;
        const without = await engine.unwrap(subject, tag);
        const result = await engine.compare(subject, without);
        unwrapped[tag] ??= { direction };
        unwrapped[tag][engine.name] = result;
      }
    }

    entries.push({ id: document.id, sanitised, normalised, sanitiser, roundTrip, unwrapped });
    process.stderr.write('.');
  }
} finally {
  for (const engine of engines) await engine.close();
  await server.close();
}
process.stderr.write('\n');

const oracle = {
  '$schema-note':
    'GENERATED by scripts/generate-pasted-html-oracle.mjs from pasted-html.corpus.json - do not edit by hand. Per document: the sanitised and normalised documents the tool produced; whether each pair renders pixel-identically and with an identical accessibility tree, per engine; and, for every element name whose count the round trip changed, whether unwrapping every one of them in the document that has more changes a pixel.',
  engines: Object.fromEntries(engines.map((engine) => [engine.name, engine.version])),
  viewport: VIEWPORT,
  calibration,
  entries,
};

await writeFile(ORACLE, `${JSON.stringify(oracle, null, 2)}\n`);
console.log(`wrote ${String(entries.length)} entries`);
