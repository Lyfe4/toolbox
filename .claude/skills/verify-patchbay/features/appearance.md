# Appearance

Patchbay ships four themes and a theme editor, all hosted on `/styleguide` alongside the component reference. A choice repaints the whole app immediately and survives a reload. The default follows the OS setting.

## Sub-features

- `preset` — four built-in themes: Graphite (dark/amber), Vellum (light/vermilion), Phosphor (dark/green), Blueprint (dark/cyan).
- `system` — the default option, which follows the OS light/dark preference.
- `persistence` — the choice is written to `localStorage` under `patchbay:theme:v1` and restored on load; the custom themes themselves are a library under `patchbay:themes:v1`.
- `editor` — build a custom theme: `Create theme`, then the seven token-group tabs (`Surfaces`, `Ink`, `Borders`, `Accent`, `Controls`, `Signal states`, `Focus and selection`) and their fields.
- `contrast-report` — the editor reports which token pairs fail WCAG AA.
- `live-preview` — a switch that applies the draft as you edit it.
- `styleguide` — the component reference the themes are demonstrated on.
- `no-flash` — an inline bootstrap script in `index.html` applies the stored theme before first paint — for a custom theme, its base and its overrides, read from `patchbay:themes:v1`.

## How to get to it (user POV)

- Open `https://patchbay-tools.netlify.app/styleguide`.
- Click `STYLEGUIDE` in the masthead.
- Change the OS light/dark setting while on the `System` option.

## Driving it with Playwright

**Preconditions:** doctor exits 0; fresh non-persistent context.

- **Land on the styleguide** → `await gotoPage(page, '/styleguide')` → `page.getByRole('heading', { level: 1, name: 'Styleguide' })` resolves.
- **Read the starting theme** → `page.evaluate(() => document.documentElement.getAttribute('data-theme'))` **and** `getComputedStyle(document.body).backgroundColor`. Record both before changing anything.
- **Pick a different theme** → choose relative to what is already active, never a hardcoded name: `const target = before.theme === 'phosphor' ? 'Graphite' : 'Phosphor'`.
- **Click it** → `await page.locator('label').filter({ hasText: new RegExp('^' + target) }).first().click()`.
- **Assert the DOM changed** → `data-theme` equals the target, lower-cased.
- **Assert the page repainted** → `getComputedStyle(document.body).backgroundColor` differs from `before`. The attribute alone proves the state changed, not that anything was painted.
- **Assert the side effect** → `localStorage['patchbay:theme:v1']` holds `{"version":1,"selection":{"kind":"preset","name":"phosphor"}}`.
- **Prove persistence by reloading** → `await page.reload({ waitUntil: 'networkidle' })` → `data-theme` is still the target. Reading back the store you just wrote proves nothing; the reload is the proof.
- **The editor** → `await page.getByRole('button', { name: 'Create theme' }).click()`, then a group tab via `page.getByRole('tab', { name: 'Ink' })` (groups are defined in `src/features/theme/tokenGroups.ts`), token fields by `page.getByRole('textbox', { name: 'ink-primary', exact: true })`, and `page.getByRole('switch', { name: 'Live preview' })`. _(Not in `drive.mjs` — see below.)_

Scripted as `driveAppearance` in `drive.mjs` (presets + persistence). Run: `node .claude/skills/verify-patchbay/drive.mjs appearance`.

## Gotchas

- **The default is not dark.** A fresh context starts on `System`, and headless Chromium reports a _light_ OS preference, so the document arrives as `vellum`. A drive that "switches to Vellum" asserts a change that never happened and passes for the wrong reason. Always pick relative to the observed starting theme. To exercise the dark path deliberately, launch the context with `colorScheme: 'dark'`.
- **Click the label, not the radio.** Each radio is a 1×1, `opacity: 0` input under a painted marker span. `.check()` on the input never lands — Playwright retries into a 30 s timeout with the marker intercepting the click. The label is what a person clicks.
- **The accessible name includes the meta line.** The radio for Vellum is named `VellumLight / Vermilion`, so `{ name: 'Vellum' }` with `exact: true` finds nothing. Anchor with `^` instead.
- **The theme is on `documentElement`, not `body`.** `data-theme` lives on `<html>`.
- **The editor is not scripted.** `Create theme`, the token fields, the contrast report and live preview are listed above with real selectors but no drive exercises them. Do not report theming as fully verified on the strength of the preset drive.
- **The no-flash bootstrap is CSP-hashed.** `index.html`'s inline theme script has its sha256 in `script-src`. If a drive ever reports that script being blocked, the build skipped `vite/plugins/csp-hash.ts` — that is a real deploy fault, not test noise.
