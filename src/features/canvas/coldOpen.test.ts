import { describe, expect, it } from 'vitest';

import { COLD_OPEN_ID, COLD_OPEN_START_ID, COLD_OPEN_STORAGE_KEY } from './coldOpen';
import { snapToGrid } from './geometry';
import { GRAPH_STORAGE_KEY } from './persistence';
import { getPreset } from './presets';
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

/**
 * WHERE THE NODES ACTUALLY ARE.
 *
 * The first version of these links put every graph at the world origin, which
 * decodes perfectly and lands both nodes in the top-left corner of the canvas,
 * half of the first one under the toolbar, with the rest of the screen empty.
 * Every assertion above passed: the tools were right, the wires were right,
 * and the screen read as broken.
 *
 * The canvas fits a share link on arrival now, which fixes the general case
 * for every link anybody sends. These two tests are the other half - that
 * these particular links are well-made rather than merely rescued, because a
 * fit that is papering over a bad link is a fit nobody can see through.
 */
describe('where the example pipelines put their nodes', () => {
  /**
   * The shape, independent of where it is.
   *
   * Compared against `PIPELINE_PRESETS`, which is the same pipeline the
   * palette builds - so a link cannot drift into a different layout from the
   * one the app itself produces for the same name. Offsets rather than
   * absolute positions: this is about the arrangement, and the test below is
   * about the place.
   *
   * Snapped on both sides, because the decoder snaps to the 8px grid and the
   * preset's own offsets are not all multiples of it.
   */
  it.each([
    ['Decode, then convert', 'decode-and-convert'],
    ['Fingerprint a CSV', 'fingerprint-csv'],
    ['Encode, then compare digests', 'encode-and-compare'],
  ])('%s is laid out like the %s preset', async (name, presetId) => {
    const index = [
      'Decode, then convert',
      'Fingerprint a CSV',
      'Encode, then compare digests',
    ].indexOf(name);
    const result = await decodeParamToGraph(shareHrefs[index] ?? '');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const preset = getPreset(presetId);
    expect(preset).toBeDefined();
    if (!preset) return;

    const first = result.graph.nodes[result.graph.nodeOrder[0] ?? ''];
    expect(first).toBeDefined();
    if (!first) return;

    const offsets = result.graph.nodeOrder.map((id) => ({
      x: (result.graph.nodes[id]?.position.x ?? 0) - first.position.x,
      y: (result.graph.nodes[id]?.position.y ?? 0) - first.position.y,
    }));

    expect(offsets).toEqual(
      preset.nodes.map((spec) => ({
        x: snapToGrid(first.position.x + spec.offset.x) - first.position.x,
        y: snapToGrid(first.position.y + spec.offset.y) - first.position.y,
      })),
    );
  });

  /*
   * And somewhere the app would have put them.
   *
   * `addPreset` drops a preset at `centre - (NODE_WIDTH, 80)` in world space,
   * which on any real canvas is a positive coordinate a comfortable distance
   * from the origin. Nothing this application creates has ever landed a node
   * at (0, 0) - that is a hand-encoded coordinate and nothing else, and it is
   * the one that was wrong.
   */
  it.each([0, 1, 2])('link %i places its nodes on the canvas, not at the origin', async (index) => {
    const result = await decodeParamToGraph(shareHrefs[index] ?? '');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    for (const id of result.graph.nodeOrder) {
      const position = result.graph.nodes[id]?.position;
      expect(position?.x).toBeGreaterThan(0);
      expect(position?.y).toBeGreaterThan(0);
    }
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
   * The panel is REMOVED for everyone else, not hidden. A hidden one is state:
   * the app would have to know about it, agree with it, and keep agreeing -
   * and the one thing it must never do is come back. Removal is the only
   * version of this that cannot be undone by a later render.
   */
  it('removes the panel rather than hiding it', () => {
    expect(indexHtml).toContain('panel.remove()');
    expect(indexHtml).not.toContain("panel.style.display = 'none'");
  });
});

/*
 * The one control that cannot work from markup alone ships saying so. The four
 * rows above it are anchors and are live the instant they are parsed; this one
 * needs the canvas, which is the entry bundle plus a lazy chunk away, and a
 * control that looks live and swallows the press is worse than one that waits
 * visibly. `onColdOpenStart` enables it at the moment it could do something.
 */
describe('the start button', () => {
  it('ships disabled', () => {
    expect(indexHtml).toMatch(/<button[^>]*id="cold-open-start"[^>]*disabled/);
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
