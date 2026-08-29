import { z } from 'zod';

/**
 * Zod, configured once for this application.
 *
 * WHY THIS MODULE EXISTS
 *
 * Zod 4 compiles a schema into a specialised validator with `new Function` the
 * first time that schema parses something. It is a real speed-up, and it is
 * also `eval` by another name - which our Content-Security-Policy forbids:
 *
 *     script-src 'self' 'wasm-unsafe-eval' 'sha256-…'
 *
 * There is no `'unsafe-eval'` in there and there is not going to be. Zod
 * handles the refusal gracefully and falls back to its interpreted path, so
 * everything still works - but every browser logs a CSP violation on the first
 * parse, and a console full of security warnings is exactly how a real one
 * gets missed. Firefox surfaced this during the cross-browser check.
 *
 * `jitless: true` tells Zod not to try. The cost is the compiled fast path,
 * which we could not use anyway; the benefit is a clean console and one fewer
 * thing to explain.
 *
 * Every module in the app imports `z` from HERE rather than from 'zod'
 * directly, so this configuration cannot be bypassed by adding a new file.
 * An ESLint `no-restricted-imports` rule enforces that.
 */
z.config({ jitless: true });

export { z };
