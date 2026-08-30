/**
 * Generates the favicon, app icons and social preview image.
 *
 * Everything here is DRAWN, not screenshotted. The marks are authored as SVG
 * and the social card as HTML, both coloured from the real token files -
 * `scripts/` reads primitives.css, semantic.css and themes.css and resolves
 * the same variables the app does, so a change to `--pb-accent` changes the
 * favicon on the next run rather than leaving it quietly out of date.
 *
 * Rasterising still needs something that can draw. Playwright is already a
 * devDependency for the cross-browser harness, so its Firefox is used as the
 * renderer; the fonts are read off disk and inlined as data: URIs, so this
 * makes no network request either.
 *
 * Run with `pnpm assets:generate`. The output is committed - it changes only
 * when the design system does, and a fresh clone should not need a browser
 * binary just to have a favicon.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { firefox } from 'playwright';
import prettier from 'prettier';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STYLES = join(ROOT, 'src', 'styles');
const PUBLIC = join(ROOT, 'public');

/* ========================================================================== *
 * Reading the design tokens
 *
 * A deliberately small CSS reader: flat blocks, custom properties only, one
 * level of var() indirection resolved by repetition. src/lib/testing/
 * cssTokens.ts does the same job for the test suite, but it uses Vite's ?raw
 * imports and so cannot be loaded from plain Node.
 * ========================================================================== */

function stripComments(css) {
  let out = '';
  let cursor = 0;
  while (cursor < css.length) {
    const start = css.indexOf('/*', cursor);
    if (start === -1) return out + css.slice(cursor);
    out += css.slice(cursor, start);
    const end = css.indexOf('*/', start + 2);
    if (end === -1) return out;
    cursor = end + 2;
  }
  return out;
}

function parseBlocks(css) {
  const source = stripComments(css);
  const blocks = [];
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf('{', cursor);
    if (open === -1) break;
    const close = source.indexOf('}', open);
    if (close === -1) break;

    const declarations = new Map();
    for (const part of source.slice(open + 1, close).split(';')) {
      const colon = part.indexOf(':');
      if (colon === -1) continue;
      const name = part.slice(0, colon).trim();
      if (!name.startsWith('--')) continue;
      declarations.set(name.slice(2), part.slice(colon + 1).trim());
    }

    blocks.push({ selector: source.slice(cursor, open).trim(), declarations });
    cursor = close + 1;
  }

  return blocks;
}

async function resolveTheme(theme) {
  const files = await Promise.all(
    ['primitives.css', 'semantic.css', 'themes.css'].map((name) =>
      readFile(join(STYLES, name), 'utf8'),
    ),
  );

  const wanted = [':root', `[data-theme='${theme}']`];
  const raw = new Map();

  for (const css of files) {
    for (const block of parseBlocks(css)) {
      const selectors = block.selector.split(',').map((part) => part.trim());
      if (!selectors.some((selector) => wanted.includes(selector))) continue;
      // Later declarations win, which is what the cascade does for these two
      // equal-specificity selectors.
      for (const [name, value] of block.declarations) raw.set(name, value);
    }
  }

  // Resolve var() chains by repetition. Six passes is far more than the two
  // the three-layer system can actually produce.
  const resolved = new Map(raw);
  for (let pass = 0; pass < 6; pass += 1) {
    for (const [name, value] of resolved) {
      const match = /^var\(--([a-z0-9-]+)\)$/i.exec(value);
      if (match && resolved.has(match[1])) resolved.set(name, resolved.get(match[1]));
    }
  }

  return (name) => {
    const value = resolved.get(name);
    if (value === undefined || value.startsWith('var(')) {
      throw new Error(`token --${name} did not resolve for theme "${theme}"`);
    }
    return value;
  };
}

/* ========================================================================== *
 * The mark
 *
 * A patch point: the port glyph from the icon set, with a cord entering from
 * the left and leaving to the right. Drawn on a 64 grid so every coordinate is
 * a whole number at 16, 32, 64, 128, 192 and 512 - no half-pixel seams at the
 * sizes that actually get used.
 * ========================================================================== */

function markSvg({ surface, border, accent, cord }, { framed = true } = {}) {
  return [
    framed ? `<rect width="64" height="64" fill="${surface}"/>` : '',
    framed
      ? `<rect x="0.5" y="0.5" width="63" height="63" fill="none" stroke="${border}" stroke-width="1"/>`
      : '',
    // The cord. Square caps, because every stroke in this system is square.
    `<path d="M0 32 H18 M46 32 H64" stroke="${cord}" stroke-width="4" stroke-linecap="butt"/>`,
    `<circle cx="32" cy="32" r="13" fill="none" stroke="${accent}" stroke-width="5"/>`,
    `<circle cx="32" cy="32" r="4.5" fill="${accent}"/>`,
  ].join('');
}

/**
 * The favicon, as SVG.
 *
 * Two palettes in one file. A tab strip is drawn in the browser's own chrome,
 * not the page's, so the icon has to answer to the OS light/dark setting
 * rather than to Patchbay's theme - `prefers-color-scheme` inside an SVG
 * favicon is honoured by Firefox and Chromium and ignored harmlessly elsewhere.
 */
function faviconSvg(dark, light) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Patchbay">
  <style>
    .surface { fill: ${dark.surface} }
    .border  { stroke: ${dark.border} }
    .accent  { stroke: ${dark.accent}; fill: none }
    .core    { fill: ${dark.accent} }
    .cord    { stroke: ${dark.cord} }
    @media (prefers-color-scheme: light) {
      .surface { fill: ${light.surface} }
      .border  { stroke: ${light.border} }
      .accent  { stroke: ${light.accent} }
      .core    { fill: ${light.accent} }
      .cord    { stroke: ${light.cord} }
    }
  </style>
  <rect class="surface" width="64" height="64"/>
  <rect class="border" x="0.5" y="0.5" width="63" height="63" fill="none" stroke-width="1"/>
  <path class="cord" d="M0 32 H18 M46 32 H64" stroke-width="4" stroke-linecap="butt"/>
  <circle class="accent" cx="32" cy="32" r="13" stroke-width="5"/>
  <circle class="core" cx="32" cy="32" r="4.5"/>
</svg>
`;
}

/* ========================================================================== *
 * The social preview
 * ========================================================================== */

async function fontFace(family, file, weight) {
  const bytes = await readFile(join(PUBLIC, 'fonts', file));
  return `@font-face{font-family:'${family}';font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2')}`;
}

/**
 * 1200x630, the size every card consumer crops from.
 *
 * Built out of the same parts the app is: a hairline-bordered panel, uppercase
 * tracked monospace labels, one accent, and a small wired graph so the picture
 * says "node canvas" without a screenshot's clutter.
 */
async function socialHtml(t) {
  const faces = [
    await fontFace('Plex', 'ibm-plex-mono-400.woff2', 400),
    await fontFace('Plex', 'ibm-plex-mono-500.woff2', 500),
    await fontFace('Plex', 'ibm-plex-mono-600.woff2', 600),
  ].join('');

  const node = (x, y, label, active = false) => `
    <g transform="translate(${x} ${y})">
      <rect width="150" height="54" fill="${t('pb-surface-raised')}"
            stroke="${active ? t('pb-accent') : t('pb-border-hairline')}" stroke-width="${active ? 2 : 1}"/>
      <rect width="150" height="18" fill="${t('pb-surface-overlay')}"
            stroke="${active ? t('pb-accent') : t('pb-border-hairline')}" stroke-width="1"/>
      <text x="8" y="13" font-family="Plex" font-size="10" letter-spacing="1.2"
            fill="${active ? t('pb-accent') : t('pb-ink-muted')}">${label}</text>
      <rect x="8" y="28" width="94" height="4" fill="${t('pb-surface-inset')}"/>
      <rect x="8" y="38" width="62" height="4" fill="${t('pb-surface-inset')}"/>
      <circle cx="0" cy="40" r="4" fill="${t('pb-surface-base')}" stroke="${t('pb-border-strong')}" stroke-width="1.5"/>
      <circle cx="150" cy="40" r="4" fill="${t('pb-surface-base')}" stroke="${t('pb-border-strong')}" stroke-width="1.5"/>
    </g>`;

  /*
   * Nudged down as a group rather than by re-numbering every node: the graph
   * has to sit against the middle of the text block, and the wires are
   * hand-tuned bezier control points that would all have to move with it.
   */
  const graph = `
    <svg width="560" height="380" viewBox="0 0 560 380" fill="none">
      <g transform="translate(0 62)">
        <path d="M154 128 C 200 128, 200 208, 246 208" stroke="${t('pb-accent')}" stroke-width="2"/>
        <path d="M400 208 C 440 208, 440 96, 480 96" stroke="${t('pb-border-strong')}" stroke-width="2"/>
        ${node(4, 88, 'BASE64')}
        ${node(246, 168, 'STRUCTURED DATA', true)}
        ${node(406, 56, 'HASH')}
      </g>
    </svg>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${faces}
    *{box-sizing:border-box;margin:0}
    body{
      inline-size:1200px;block-size:630px;display:flex;flex-direction:column;
      justify-content:space-between;padding:72px;
      background:${t('pb-surface-base')};color:${t('pb-ink-primary')};
      font-family:'Plex',monospace;
      /* The 8px grid, drawn faintly - the same motif as the canvas itself. */
      background-image:
        linear-gradient(${t('pb-surface-raised')} 1px, transparent 1px),
        linear-gradient(90deg, ${t('pb-surface-raised')} 1px, transparent 1px);
      background-size:48px 48px;
    }
    .top{display:flex;align-items:flex-start;justify-content:space-between;gap:48px}
    .mark{display:flex;align-items:center;gap:20px}
    .mark svg{inline-size:64px;block-size:64px;display:block}
    .wordmark{font-size:40px;font-weight:600;letter-spacing:6px;text-transform:uppercase}
    .lede{margin-block-start:40px;font-size:34px;font-weight:400;line-height:1.35;max-inline-size:18ch}
    .accent{color:${t('pb-accent')}}
    .foot{display:flex;align-items:center;gap:16px;
      font-size:16px;font-weight:500;letter-spacing:3px;text-transform:uppercase;
      color:${t('pb-ink-muted')}}
    .rule{block-size:1px;background:${t('pb-border-hairline')};flex:1}
    .chip{border:1px solid ${t('pb-border-hairline')};padding:8px 14px;color:${t('pb-ink-secondary')}}
    .chip.on{border-color:${t('pb-accent')};color:${t('pb-accent')}}
  </style></head><body>
    <div class="top">
      <div>
        <div class="mark">
          <svg viewBox="0 0 64 64">${markSvg(
            {
              surface: t('pb-surface-raised'),
              border: t('pb-border-hairline'),
              accent: t('pb-accent'),
              cord: t('pb-border-strong'),
            },
            { framed: true },
          )}</svg>
          <span class="wordmark">Patchbay</span>
        </div>
        <p class="lede">A developer toolbox that never<br/><span class="accent">leaves the page.</span></p>
      </div>
      ${graph}
    </div>
    <div class="foot">
      <span class="chip on">connect-src 'none'</span>
      <span class="chip">no backend</span>
      <span class="chip">works offline</span>
      <span class="rule"></span>
      <span>Runs in your browser</span>
    </div>
  </body></html>`;
}

/* ========================================================================== *
 * ICO
 *
 * A one-image ICO whose payload is simply a PNG. Every browser still asking
 * for /favicon.ico understands PNG-in-ICO, and it saves hand-rolling a BMP.
 * ========================================================================== */

function ico(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry.writeUInt8(size < 256 ? size : 0, 0); // width, 0 means 256
  entry.writeUInt8(size < 256 ? size : 0, 1); // height
  entry.writeUInt8(0, 2); // palette size
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, png]);
}

/* ========================================================================== */

const dark = await resolveTheme('graphite');
const light = await resolveTheme('vellum');

const darkMark = {
  surface: dark('pb-surface-raised'),
  border: dark('pb-border-hairline'),
  accent: dark('pb-accent'),
  cord: dark('pb-border-strong'),
};
const lightMark = {
  surface: light('pb-surface-raised'),
  border: light('pb-border-hairline'),
  accent: light('pb-accent'),
  cord: light('pb-border-strong'),
};

await writeFile(join(PUBLIC, 'favicon.svg'), faviconSvg(darkMark, lightMark), 'utf8');
console.log('favicon.svg');

const browser = await firefox.launch();
const page = await browser.newPage();

async function raster(html, width, height, file) {
  await page.setViewportSize({ width, height });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const buffer = await page.screenshot({ clip: { x: 0, y: 0, width, height } });
  await writeFile(join(PUBLIC, file), buffer);
  console.log(`${file} - ${width}x${height}, ${(buffer.length / 1024).toFixed(1)} kB`);
  return buffer;
}

/** A page holding nothing but the mark, sized to fill it exactly. */
function markPage(mark, size) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0}
    html,body{inline-size:${size}px;block-size:${size}px;overflow:hidden}
    svg{display:block;inline-size:${size}px;block-size:${size}px}
  </style></head><body><svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">${markSvg(mark)}</svg></body></html>`;
}

// Maskable-safe these are not: the manifest declares them "any", because the
// mark is a framed panel and a maskable crop would cut its border off.
await raster(markPage(darkMark, 192), 192, 192, 'icon-192.png');
await raster(markPage(darkMark, 512), 512, 512, 'icon-512.png');
// iOS ignores transparency and rounds the corners itself, so the framed mark
// is exactly right here.
await raster(markPage(darkMark, 180), 180, 180, 'apple-touch-icon.png');

const png32 = await raster(markPage(darkMark, 32), 32, 32, 'icon-32.png');
await writeFile(join(PUBLIC, 'favicon.ico'), ico(png32, 32));
console.log('favicon.ico');

await raster(await socialHtml(dark), 1200, 630, 'social-preview.png');

await browser.close();

/* ========================================================================== *
 * The web manifest
 *
 * Generated here rather than hand-written so its colours cannot drift from the
 * theme. `theme_color` is the header surface and `background_color` the page
 * surface, both from graphite - an installed app has no OS preference to
 * follow at splash time, so it gets the default theme.
 * ========================================================================== */

const manifest = {
  name: 'Patchbay',
  short_name: 'Patchbay',
  description:
    'A developer toolbox that runs entirely in your browser. Nothing you paste ever leaves the page.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  theme_color: dark('pb-surface-raised'),
  background_color: dark('pb-surface-base'),
  categories: ['developer', 'utilities', 'productivity'],
  icons: [
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  ],
};

/*
 * Formatted with Prettier rather than by JSON.stringify alone, so that
 * regenerating this file can never fail `pnpm format:check`. Prettier collapses
 * short arrays where JSON.stringify always expands them, which is exactly the
 * kind of difference that turns a generated file into a recurring nuisance.
 */
const manifestPath = join(PUBLIC, 'site.webmanifest');
await writeFile(
  manifestPath,
  await prettier.format(JSON.stringify(manifest), {
    ...(await prettier.resolveConfig(manifestPath)),
    parser: 'json',
  }),
  'utf8',
);
console.log('site.webmanifest');

const svg = await readFile(join(PUBLIC, 'favicon.svg'));
console.log(`\nfavicon.svg sha256 ${createHash('sha256').update(svg).digest('hex').slice(0, 12)}`);
