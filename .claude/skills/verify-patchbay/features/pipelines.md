# Pipelines and sharing

The point of the canvas is wiring tools into a chain: one tool's output port feeds the next tool's input port, and editing the head re-runs everything downstream. A whole graph can be encoded into a share link, which is how the cold open offers ready-made pipelines and how a user hands one to someone else.

## Sub-features

- `wire` — connecting an output port to a compatible input port.
- `type-compatibility` — ports advertise types (`text`, `json`, `bytes`); incompatible pairs cannot be wired.
- `flow` — a value entered at the head arrives at the tail, transformed by each step.
- `blocked` — a node with no upstream value reports `Waiting upstream`; the head reports `Needs input`.
- `share-encode` — the `Share` toolbar button encodes the graph into a `?p=` link (secrets excluded).
- `share-decode` — opening a `?p=` link installs that graph, with no cold open.
- `disconnect` — the inspector's `Disconnect` button removes a wire.
- `loss-report` — a conversion that drops information says so rather than failing silently.

## How to get to it (user POV)

- Drag from a node's output port glyph to another node's input port on the canvas.
- Click a node's `CONNECT` affordance, then pick a target.
- Follow one of the three pipeline links in the cold open:
  - **Decode, then convert** — Base64 → JSON to YAML
  - **Fingerprint a CSV** — CSV to JSON → SHA-256
  - **Encode, then compare digests** — Base64 → SHA-256 and MD5
- Open any `/?p=<payload>` share link.
- Press `Share` in the canvas toolbar to produce a link for the current graph.

## Driving it with Playwright

**Preconditions:** doctor exits 0; fresh non-persistent context.

The `COLD_OPEN_LINKS` map in `drive.mjs` holds the three hrefs copied from `index.html`. Decode one to see exactly what it installs — no guessing:

```bash
node -e "const{inflateRawSync}=require('node:zlib');const p=process.argv[1];console.log(inflateRawSync(Buffer.from(p.replace(/-/g,'+').replace(/_/g,'/'),'base64')).toString())" '<payload>'
```

`decode-then-convert` decodes to `{"v":3,"n":[["n1","base64",…,{"mode":"decode"}],["n2","structured-data",…,{"target":"yaml"}]],"e":[["n1","output","n2","input"]]}` — which is why `node-n1` and `node-n2` below are stable ids rather than lucky guesses.

- **Install the graph** → `await gotoCanvas(page, COLD_OPEN_LINKS['decode-then-convert'])` → `readout(page)` is `2 nodes · 1 wire · idle · 100%`; no cold open appeared.
- **Confirm which graph** → `page.locator('[data-testid^="node-"]').evaluateAll(els => els.map(el => el.getAttribute('aria-label')))` → one label matches `/base64/i`, another `/structured data/i`.
- **Assert the blocked starting state (the positive partner)** → the labels contain `Needs input` and `Waiting upstream`. Without this, "nothing is in error" would pass on a pipeline that never executed.
- **Feed the head** → `await page.getByTestId('node-n1').click()` → `await setInspector(page, true)` → `await page.getByLabel('Base64 input').fill(base64OfSomeJSON)` → `await waitForPipelineIdle(page)`.
- **Read the tail** → `await page.getByTestId('node-n2').click()` → `await page.getByLabel('Structured data Converted').inputValue()`.
- **Prove the wire carried data** → the tail's YAML contains values that only exist in the JSON you encoded at the head, e.g. `/^tool:\s*patchbay$/m`.
- **Prove the transform happened** → the tail output is YAML, not the JSON it arrived as: no `{`, no `"tool"`.
- **Confirm the graph settled** → readout contains no `error` item.

Scripted as `drivePipelines` in `drive.mjs`. Run: `node .claude/skills/verify-patchbay/drive.mjs pipelines`.

## Gotchas

- **Installed is not working.** Straight off a share link both nodes sit blocked and every output is empty. A drive that only counts nodes and wires proves the decoder ran, nothing more. Feed the head and read the tail.
- **The cold-open links are copied, not generated.** If `index.html`'s `<a class="cold-open-way">` hrefs change, `COLD_OPEN_LINKS` in `drive.mjs` goes stale and the drive will verify a graph nobody ships. Re-copy them when the cold open changes.
- **Node ids come from the share payload.** `node-n1` / `node-n2` are stable _for these links_. A graph built through the palette gets generated ids — select by `aria-label` instead.
- **Selecting a node is what routes the inspector.** The inspector shows the _selected_ node; clicking the node face selects it. Reading `Structured data Converted` while `n1` is selected finds nothing.
- **Share links deliberately omit secrets.** `secretOptionKeys` in the manifest (e.g. a JWT verification key) are stripped by the encoder, so a shared JWT pipeline arrives unable to verify until the key is retyped. That is correct behaviour, not a bug to report.
- **Don't build the `p` payload by hand for a proof of the encoder.** Press `Share` and decode what the app produced; a payload you constructed only proves the decoder.
