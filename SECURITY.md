# Security

Patchbay is a static site that runs entirely in the browser. There is no
backend, no account, no database and no request to any other origin. That
shapes what it can and cannot protect you from, and this document tries to be
precise about both — an overclaimed security document is worse than none,
because it invites people to trust it for things it never covered.

## Threat model

**What Patchbay is for.** Pasting things you would not paste into a website:
a JWT you are debugging, a config file with a connection string, an API
response with customer records, a certificate, a screenshot of an internal
dashboard. The design assumption is that the data is sensitive and the network
is hostile.

**Who it defends against.** A passive network observer, the site's own
operator, and the site's own future operator. There is nothing to intercept
and nothing retained, because the data never moves.

**Who it does not defend against.** Anyone who already controls the machine or
the browser. See [What this does not protect against](#what-this-does-not-protect-against).

## What is actually enforced

Every claim below is a mechanism, not an intention. The point of listing them
is that each one is a visible change to a reviewed file if it is ever removed.

### The data never leaves the page

[`public/_headers`](public/_headers) serves every document with
`connect-src 'none'`. The browser itself refuses `fetch`, `XMLHttpRequest`,
`WebSocket`, `EventSource` and `navigator.sendBeacon`. Application code cannot
phone home — not by mistake, not through a compromised dependency, not through
injected script — because the refusal happens below the JavaScript, in the
network stack.

`scripts/cross-browser-check.mjs` asserts that no request leaves the origin
while the app is driven through a real workload in two engines.

### Pasted input cannot become code

- `script-src` carries no `'unsafe-inline'` and no `'unsafe-eval'`. The single
  inline bootstrap script is allowed by its sha256, computed from the built
  output by [`vite/plugins/csp-hash.ts`](vite/plugins/csp-hash.ts).
- ESLint bans `eval`, `new Function`, `innerHTML`, `insertAdjacentHTML` and
  `dangerouslySetInnerHTML` across the whole source tree.
- `object-src 'none'`, `base-uri 'self'`, `form-action 'none'`,
  `frame-ancestors 'none'`.

### Untrusted input is treated as untrusted

- Files are size-capped **before** they are read, and identified by **magic
  bytes** rather than by the media type the OS guessed from the extension.
- A share link is bounded before decompression, capped again while
  decompressing, then validated with Zod — including checking every tool id
  against the live registry, so a hostile link cannot trigger a dynamic import
  of something that is not a real tool.
- Parsed objects are built with `Object.defineProperty`, so a `__proto__` key
  in someone's YAML creates a property instead of replacing a prototype.
- User-supplied regexes run under a time bound, because a catastrophically
  backtracking pattern would otherwise hang the tab.

### Share links never carry your data

A share link encodes the pipeline's _shape_ — which tools, where, wired how,
with which settings. `CanvasNode.input` is absent from the payload and from
the schema that reads one back; `toSharePayload` lists the fields it copies
explicitly rather than spreading the node; and `share.test.ts` asserts that a
secret typed into a node appears neither in the encoded parameter nor in
anything decoded from it.

Option keys that hold secrets are declared in the manifest
(`secretOptionKeys`) and stripped — a JWT verification key is an _option_, not
an input, and would otherwise have travelled.

## The one deliberate exception

**The service worker is served with `connect-src 'self'` instead of
`connect-src 'none'`.**

A worker is governed by the CSP delivered with its own script, not the page's.
Under the global policy it inherits `connect-src 'none'`, which refuses
`cache.addAll` and every `fetch` inside it — so it installs and then can never
populate its cache, and offline support silently does nothing. This was
measured, not assumed.

[`public/_headers`](public/_headers) therefore serves `/sw.js` with its own
policy permitting connections to Patchbay's own origin, and nowhere else.

What this changes:

- The service worker may request files from `patchbay`'s origin. That is where
  its cache comes from.
- It may not reach any other origin. `connect-src 'self'` is same-origin only,
  so there is no destination to exfiltrate to.
- **The document is unaffected.** Pages still run under `connect-src 'none'`.
  Application code — your tool inputs, the canvas, everything you paste — still
  cannot make a network request of any kind.

The exception is narrow and it is written down here rather than left to be
discovered in a header file. If you would rather not have it, deleting the
`/sw.js` block in `public/_headers` and the registration in
[`src/app/registerServiceWorker.ts`](src/app/registerServiceWorker.ts) removes
offline support and restores a uniform `connect-src 'none'`.

## What this does not protect against

This is the part that matters. Local-only architecture is a strong guarantee
about the _network_. It is not a guarantee about your machine.

**A compromised dependency.** Patchbay ships other people's code. CSP stops a
malicious package from making a network request, and the ESLint rules stop it
from being introduced through our own source — but a compromised package could
still read what you paste, corrupt a result, write to `localStorage`, or wait
for a future version that relaxes a header. `connect-src 'none'` raises the
cost of exfiltration considerably; it does not make a supply-chain compromise
harmless. Dependencies are pinned, the lockfile is committed and CI installs
with `--frozen-lockfile`, which means a change is reviewable — not that it will
be reviewed.

**A malicious browser extension.** Extensions run with the page's privileges
and above its CSP. An extension can read every value in every field, exfiltrate
it over its own connection, and modify the page. Nothing a web page can do
prevents this. If you are pasting something that genuinely must not leak, use a
browser profile with no extensions.

**A compromised machine.** Keyloggers, screen capture, malware reading browser
storage, someone reading over your shoulder. Out of scope entirely.

**A hostile share link.** A link is validated and cannot execute code or load a
tool that does not exist, and it carries no input data. But it is still
attacker-controlled structure: it can build a pipeline you did not intend and
label it however it likes. Read a link before you run it, the same as you would
read a script before you run it.

**Your own clipboard and downloads.** Copying a decoded secret puts it on the
system clipboard, which other applications can read. Saving output writes it to
disk unencrypted. Both are you asking for it, which is fine — just be aware
that the guarantee ends at the edge of the page.

**Cryptographic correctness for adversarial use.** The hash and JWT tools use
the platform's `SubtleCrypto`, but Patchbay is a debugging aid. It is not
audited, it is not constant-time in its surrounding code, and it should not be
the thing standing between an attacker and a signature decision.

**Availability.** A large enough input can still make the tab unresponsive,
and a decompression bomb is bounded rather than impossible. The failure mode
is a slow or dead tab, which costs you the tab.

## Reporting a vulnerability

Open an issue describing the problem and how to reproduce it. Do not include
real secrets in the report — a synthetic example that shows the same behaviour
is more useful anyway, and cannot leak.

Because there is no server, there is nothing to patch centrally: a fix reaches
people when they load the site again. There is no user data to breach and no
credentials to rotate.
