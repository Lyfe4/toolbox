import { describe, expect, it } from 'vitest';

import { COLD_OPEN_ID, COLD_OPEN_START_ID, COLD_OPEN_STORAGE_KEY } from './coldOpen';
import { GRAPH_STORAGE_KEY } from './persistence';
import { decodeParamToGraph } from './share';
import indexHtml from '../../../index.html?raw';

/**
 * THE COLD OPEN'S MARKUP, CHECKED AGAINST THE CODE IT PROMISES THINGS ABOUT.
 *
 * The first screen at `/` is hand-written HTML in index.html, which buys three
 * things nothing else here could - it exists for a crawler, it paints before
 * the canvas chunk is fetched, and it costs the JavaScript payload nothing -
 * at one price: nothing in the type system connects it to the app.
 *
 * So it is connected here instead. Three joins, each of which has a plausible
 * way of going wrong silently:
 *
 *   1. the example links are real share links, encoded by hand once. A change
 *      to the share format, to a tool's id, or to a port's name would leave
 *      them decoding to an empty canvas, and the first person to find out
 *      would be a visitor clicking the first thing on the page;
 *   2. the inline script reads the graph's localStorage key by literal, from a
 *      file that cannot import it. Bumping the key in persistence.ts would
 *      hand every returning visitor an introduction to a product they use;
 *   3. the ids the app looks up have to be the ids the markup carries, and
 *      `getElementById` returning null is the quietest failure in the DOM.
 *
 * Read with Vite's `?raw`, like the head tests next door: these are assertions
 * about the SHIPPED TEXT, so a DOM parse would paper over a malformed tag a
 * browser happened to recover from.
 */

/** Every `href="/?p=..."` in the document, in source order. */
const shareHrefs = [...indexHtml.matchAll(/href="\/\?p=([\w-]+)"/g)].map((match) => match[1]);

describe('the example pipelines', () => {
  it('are all there', () => {
    expect(shareHrefs).toHaveLength(3);
  });

  /**
   * What each link is advertised as, beside what it must actually decode to.
   *
   * The tool ids are spelled out rather than derived, because deriving them
   * from the same source the link was built from would assert nothing: the
   * point is that the URL in the document produces the pipeline the row next
   * to it claims.
   */
  it.each([
    ['Decode, then convert', ['base64', 'structured-data'], 1],
    ['Fingerprint a CSV', ['structured-data', 'hash'], 1],
    ['Encode, then compare digests', ['base64', 'hash', 'hash'], 2],
  ])('%s decodes to its pipeline', async (name, toolIds, wires) => {
    const index = [
      'Decode, then convert',
      'Fingerprint a CSV',
      'Encode, then compare digests',
    ].indexOf(name);
    const param = shareHrefs[index];
    expect(param).toBeDefined();

    const result = await decodeParamToGraph(param ?? '');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    expect(result.graph.nodeOrder.map((id) => result.graph.nodes[id]?.toolId)).toEqual(toolIds);
    expect(result.graph.edgeOrder).toHaveLength(wires);
  });

  it('carries no input data, exactly like every other share link', async () => {
    for (const param of shareHrefs) {
      const result = await decodeParamToGraph(param ?? '');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') continue;

      for (const id of result.graph.nodeOrder) {
        expect(result.graph.nodes[id]?.inputs).toEqual({});
        expect(result.graph.nodes[id]?.fileInputs).toEqual({});
      }
    }
  });

  /*
   * Every row names the tools it wires together, so someone can tell what a
   * link does before clicking it. That is the whole reason the rows have a
   * second line, and a row whose second line went missing would look like a
   * link to nowhere.
   */
  it.each([
    'Base64 &rarr; JSON to YAML',
    'CSV to JSON &rarr; SHA-256',
    'Base64 &rarr; SHA-256 and MD5',
  ])('is labelled with its signal path (%s)', (path) => {
    expect(indexHtml).toContain(path);
  });
});

describe('the inline bootstrap', () => {
  it('reads the graph under the key persistence writes it to', () => {
    expect(indexHtml).toContain(`'${GRAPH_STORAGE_KEY}'`);
  });

  it('reads the dismissal flag under the key the app writes it to', () => {
    expect(indexHtml).toContain(`'${COLD_OPEN_STORAGE_KEY}'`);
  });

  it('makes the app inert rather than leaving it tabbable behind the panel', () => {
    expect(indexHtml).toContain('root.inert = true');
  });

  /*
   * The panel is REMOVED for everyone else, not hidden. A hidden one is state
   * the app would then have to know about, and `display: none` from a
   * stylesheet cannot be promised in dev, where the CSS arrives with the
   * module rather than before it.
   */
  it('removes the panel rather than hiding it', () => {
    expect(indexHtml).toContain('panel.remove()');
    expect(indexHtml).not.toContain("panel.style.display = 'none'");
  });
});

describe('the ids the app looks up', () => {
  it.each([COLD_OPEN_ID, COLD_OPEN_START_ID])('%s exists in the markup', (id) => {
    expect(indexHtml).toContain(`id="${id}"`);
  });
});

describe('the claims on the panel', () => {
  /*
   * These three are the product's whole case, and each of them is checked
   * somewhere else in this repo: the directive by the cross-browser harness
   * against the real headers, the offline claim by the same harness, and the
   * keyboard path by Canvas.test.tsx. Naming them here means the copy cannot
   * drift away from the things that were verified without a test noticing.
   */
  it.each(["connect-src 'none'", 'Works offline after the first load', 'A complete keyboard path'])(
    'says %s',
    (claim) => {
      expect(indexHtml).toContain(claim);
    },
  );

  it('points at the plain list as well as the canvas', () => {
    expect(indexHtml).toContain('href="/tools"');
  });
});
