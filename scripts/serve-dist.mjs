/**
 * Serves the production build the way Netlify would.
 *
 * `vite preview` does not apply `public/_headers`, so it serves a different
 * application from the one that gets deployed - no CSP, no cross-origin
 * isolation, no cache rules. Everything that audits or drives the built app
 * goes through here instead, so they are all looking at the same thing.
 *
 * Run it directly (`pnpm serve:dist`) to poke at the real build by hand, or
 * import `serveDist` from a harness.
 */
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DIST = join(ROOT, 'dist');

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * A static server for `dist`, applying the same headers as `public/_headers`.
 *
 * Serving without the CSP would be testing a different application: a header
 * that breaks the worker or the fonts in one engine and not another is exactly
 * the kind of divergence this script exists to catch.
 */
export async function serveDist(port = 4319) {
  const ORIGIN = `http://127.0.0.1:${port}`;
  const rules = await readHeaders();

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', ORIGIN);
      let filePath = normalize(join(DIST, decodeURIComponent(url.pathname)));

      if (!filePath.startsWith(DIST)) {
        response.writeHead(403).end();
        return;
      }

      let body;
      try {
        const info = await stat(filePath);
        if (info.isDirectory()) filePath = join(filePath, 'index.html');
        body = await readFile(filePath);
      } catch {
        // SPA fallback, exactly as `_redirects` specifies: every unknown path
        // is a client route, served the document with a 200.
        filePath = join(DIST, 'index.html');
        body = await readFile(filePath);
      }

      /*
       * Compress when asked, because Pages does.
       *
       * Without this the audit numbers are pessimistic by roughly a factor of
       * three on the critical path - the initial JS is 311 kB raw and 101 kB
       * gzipped - and a Lighthouse run against an uncompressed server measures
       * a deployment nobody has.
       */
      const type = MIME[extname(filePath)] ?? 'application/octet-stream';
      const compressible = /^(text\/|application\/(javascript|json|manifest|xml)|image\/svg)/.test(
        type,
      );
      const wantsGzip = (request.headers['accept-encoding'] ?? '').includes('gzip');

      if (compressible && wantsGzip) {
        const gzipped = gzipSync(body);
        response.writeHead(200, {
          'content-type': type,
          'content-encoding': 'gzip',
          // Any cache keyed on the URL alone would otherwise be able to hand a
          // gzipped body to a client that did not ask for one.
          vary: 'Accept-Encoding',
          ...headersFor(rules, url.pathname),
        });
        response.end(gzipped);
        return;
      }

      response.writeHead(200, {
        'content-type': type,
        ...headersFor(rules, url.pathname),
      });
      response.end(body);
    })();
  });

  await new Promise((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });

  return server;
}

/**
 * Parses the flat `_headers` file into an ordered list of rules.
 *
 * Read from `dist`, not `public`: the source copy still carries the
 * {{INLINE_SCRIPT_HASHES}} placeholder, and serving that would test a policy
 * nobody deploys - it blocks the inline theme script in every engine. The
 * built copy has the real hash written in by the csp-hash plugin.
 *
 * The whole list is kept, not just `/*`, because the caching rules and the
 * service worker's own policy are per-path - and the worker in particular does
 * not install at all under the global `connect-src 'none'`, so a harness that
 * flattened everything to the global block would be testing an app that has no
 * offline support.
 */
export async function readHeaders() {
  const raw = await readFile(join(DIST, '_headers'), 'utf8');
  const rules = [];
  let current = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      current = { pattern: trimmed, headers: {} };
      rules.push(current);
      continue;
    }

    if (!current) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    current.headers[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
  }

  return rules;
}

/**
 * The headers Netlify would send for one path.
 *
 * Every rule whose pattern matches is applied in file order, and the last one
 * wins for a repeated header name - which is what makes it correct to put `/*`
 * first and override per path afterwards. Checked against `netlify dev`, not
 * inferred: /sw.js came back carrying only its own Content-Security-Policy,
 * not that policy appended to the global one.
 */
export function headersFor(rules, pathname) {
  const out = {};

  for (const rule of rules) {
    const matched = rule.pattern.endsWith('*')
      ? pathname.startsWith(rule.pattern.slice(0, -1))
      : pathname === rule.pattern;
    if (matched) Object.assign(out, rule.headers);
  }

  /*
   * CROSS-BROWSER FINDING, and why one directive is dropped here.
   *
   * `upgrade-insecure-requests` rewrites http:// subresources to https://.
   * Chromium and Gecko exempt loopback from that; WebKit does not, so every
   * asset on http://127.0.0.1 is upgraded and then fails to connect - the page
   * loads a bare HTML document and nothing else.
   *
   * In production the app is served over https, where the directive is a
   * belt-and-braces no-op. Here it would only mean testing the wrong thing, so
   * it is removed from the policy this harness serves - and named, rather than
   * quietly dropped, because it is a genuine engine difference.
   */
  const csp = out['Content-Security-Policy'];
  if (typeof csp === 'string') {
    out['Content-Security-Policy'] = csp
      .split(';')
      .map((directive) => directive.trim())
      .filter((directive) => directive !== 'upgrade-insecure-requests')
      .join('; ');
  }

  return out;
}

/* -------------------------------------------------------------------------- */

/*
 * Run as a CLI: `node scripts/serve-dist.mjs [port]`.
 *
 * pathToFileURL rather than string-building the URL: on Windows argv[1] is a
 * backslashed drive path and import.meta.url is `file:///C:/...` with three
 * slashes, so a hand-built comparison never matches and the CLI silently
 * does nothing.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 4319);
  await serveDist(port);
  console.log(`Serving dist with the real _headers on http://127.0.0.1:${port}`);
  console.log('Ctrl-C to stop.');
}
