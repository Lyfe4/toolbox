# Tools index

`/tools` is the plain, keyboard-first list of every tool, kept alongside the canvas rather than replacing it. A user browses it, searches it, filters it by category, and clicks through to run one tool on its own.

## Sub-features

- `listing` — one card per tool, each naming the tool, its summary and the data types it accepts and emits.
- `count` — a live count of how many tools are showing.
- `search` — matches names, summaries, categories **and** keywords, so `sha` finds Hash by keyword and `hashing` finds it by category.
- `category-filter` — a select narrowing to one of the registry's categories - `TOOL_CATEGORIES` in `src/features/registry/types.ts`, which the select is built from (this listed five by hand and missed `time` the round it came back).
- `navigation` — each card links to `/tools/<id>`.
- `privacy-panel` — the footer panel explaining why nothing leaves the tab.

## How to get to it (user POV)

- Open `https://patchbay-tools.netlify.app/tools` directly.
- Click `TOOLS` in the masthead.
- Follow the cold open's fourth preset link, "Every tool, one at a time".

## Driving it with Playwright

**Preconditions:** doctor exits 0; fresh non-persistent context. No cold open on this route.

- **Land on the index** → `await gotoPage(page, '/tools')` → `page.getByRole('heading', { level: 1, name: 'Every tool' })` resolves.
- **Read the count** → `await page.getByTestId('tool-count').textContent()` → `<n> tools`, where n is the manifest's.
- **Enumerate the cards** → `page.locator('a[href^="/tools/"]').evaluateAll(els => [...new Set(els.map(el => el.getAttribute('href')))])` → exactly the manifest's ids, compared as a set by `compareWithManifest`. Each card is a single link, so the `Set` is a guard rather than a necessity; this line used to say a card may carry more than one link to the same tool, and none does.
- **Search** → `await page.getByLabel('Search').fill('sha')`, pause ~250 ms → the count drops and the surviving hrefs include `/tools/hash`. This is the keyword path — `sha` appears in Hash's `keywords`, not in its name.
- **Clear the search** → `await page.getByLabel('Search').fill('')` → every card returns. The positive partner to "searching narrows the list": without it, a filter that removed everything permanently would pass.
- **Filter by category** → `await page.getByRole('combobox', { name: 'Category' }).click()` then `page.getByRole('option', { name: 'Hashing', exact: true }).click()` → only `hashing` tools remain (`/tools/hash`).
- **Click through** → click a card → the URL is `/tools/<id>` and that tool's `h1` renders.

Scripted as `driveToolsIndex` in `drive.mjs`. Run: `node .claude/skills/verify-patchbay/drive.mjs tools-index`.

### Search in depth

`driveToolsIndex` proves one query (`sha`, the keyword path) and clearing. `probe-search.mjs` proves the whole contract — **run it whenever search, the manifest, or `searchTools` changes**:

```bash
node .claude/skills/verify-patchbay/probe-search.mjs
```

It builds its oracle **from `src/features/registry/manifest.ts`**, not from the page: for each query it works out which tools contain it in their name, summary, category or keywords, and requires the page to return exactly that set. Queries are chosen to isolate each match source, verified isolating before being written down:

| Query          | Isolates                                   | Expected                   |
| -------------- | ------------------------------------------ | -------------------------- |
| `structured`   | name only                                  | `structured-data`          |
| `highlighting` | summary only                               | `diff`                     |
| `repackage`    | summary only                               | `video-remux`              |
| `checksum`     | keyword only                               | `hash`                     |
| `hashing`      | category only                              | `hash`                     |
| `jwt`          | keyword reaching a tool that never says it | `base64`, `jwt-decode`     |
| `convert`      | multi-match                                | whatever the manifest says |
| `SHA` vs `sha` | case-insensitivity                         | same set                   |
| `zzznope`      | no match                                   | empty, then recoverable    |

The oracle throws if it parses anything other than 10 entries — a silently-empty oracle would make every check pass vacuously.

## Gotchas

- **Compare a `Set` of hrefs, not `locator.count()`.** Each card is one anchor today, so the two agree; the `Set` is what keeps the check right if a card ever gains a second link. (This gotcha used to say cards already contain several; they never did.)
- **Opening the category select must log nothing.** It used to log six CSP refusals, which this skill filed as known noise; they were two library stylesheets, and they are fixed. If a refusal comes back, it is a regression - run `probe-popover.mjs` to see what is refused and where the list lands, before deciding anything about it.
- **The category select is a Radix combobox, not a native `<select>`.** `selectOption()` does nothing. Click the combobox, then click the `option` role in the popover — the pattern `drive.mjs` uses for `Category` here. (This line used to say it was the pattern for `Target format` on tool pages; `drive.mjs` drives no `Target format` select.)
- **Search is debounced in the UI.** Assert after a short pause or on the expected count, not synchronously after `fill()`.
- **The cards are compared with the manifest, never with a number.** Until round twenty-five `drive.mjs` asserted `=== 10` and `probe-search.mjs` asserted 10 in two places and 11 in one; the eleventh tool left the search probe throwing before it opened a browser and the index drive failing against the live site that HAD deployed it - while a stale deploy one tool short would have passed both. "Is the live site stale?" is the question a count cannot ask. `manifestTools()` in `harness.mjs` reads the working tree's manifest (checked against the tool directories on disk, so a pattern that stops matching throws rather than passing everything), and `compareWithManifest` names every id the page lacks or adds. Nothing here changes when a tool is added. Do not replace it with `>= n`: that passes on a deploy missing the newest tool, which is the stale case.
- **A no-match query needs its positive partner.** "`zzznope` shows nothing" passes just as happily on a search box that has wedged itself empty. `probe-search.mjs` clears the field afterwards and requires every card the manifest names back, in the same order as before.
- **Adding a keyword to the manifest changes what search should return.** The oracle reads the manifest, so `probe-search.mjs` follows automatically — but a query chosen here to isolate one match source can stop isolating it. Re-check the table above when keywords change.
