# Regex

Test a regular expression against text, with groups and replacement.

## The hazard, and the only defence that works

JavaScript's regex engine backtracks. For a pattern like `(a+)+$` against a run
of `a`s with a non-matching tail, the number of ways to partition the input
grows **exponentially**. Twenty-seven characters is enough to hang a tab.

There is no way to interrupt it from inside. `RegExp.prototype.exec` is a single
synchronous call into the engine: no `AbortSignal` reaches it, no step budget
exists, no callback ever runs. Every working "regex timeout" in JavaScript works
the same way — **put the call somewhere killable, and kill it**.

So this tool:

- declares `strategy: 'worker'`, so the call is somewhere killable;
- declares `timeoutMs: 2000`, deliberately short. Any pattern worth using on a
  few hundred kB finishes in milliseconds, so a run that reaches two seconds is
  overwhelmingly a blow-up rather than honest work. Waiting thirty seconds to
  say so would just be thirty seconds of a dead tab;
- declares its own `timeoutMessage`. The engine terminates and replaces the
  worker and reports **that pattern is too slow… almost certainly backtracking
  catastrophically** — not "the tool took too long", which would send the user
  looking for a bug in Patchbay rather than at their own pattern.

`ExecutionMeta.timeoutMessage` exists for this tool. `engine.test.ts` asserts the
engine prefers it over the generic text while still reporting the code as
`timeout` and saying how long it waited.

## The second way to hang a tab

A **global** pattern that can match the empty string never advances `lastIndex`
on its own, so `while ((m = re.exec(s)))` loops forever on `a*`. `runRegex`
advances `lastIndex` by one after a zero-length match, which is the standard
remedy, and there is a test for it.

`MAX_MATCHES` (5,000) is the third bound: a fast pattern on a large input can
still produce a million result objects. Past the limit the run stops and the
summary says so, rather than quietly returning a partial list.

## What is tested about the slow case

Two things can honestly be tested without hanging CI:

1. **The hazard is real.** The test walks the input length up from twelve until
   a run takes 200 ms, then asserts it happened below forty characters, and that
   four fewer characters is at least four times less work. That is the shape of
   an exponential curve, measured rather than asserted. Walking up rather than
   pinning a length keeps it from being hostage to how fast the machine is; each
   step roughly doubles, so the whole loop costs about twice its last
   measurement.
2. **The tool is configured to be killed and to explain itself** — the manifest
   assertions above.

The actual terminate-and-replace path is covered in `engine.test.ts` with an
injected clock, which is the only way to test it deterministically.

## Options

| Option                  | Effect                                       |
| ----------------------- | -------------------------------------------- |
| Pattern                 | Written without slashes.                     |
| Mode                    | Find matches, or replace.                    |
| Replacement             | `$1`, `$<name>`, `$&` all work.              |
| Global (g)              | Every match rather than the first.           |
| Ignore case (i)         |                                              |
| Multiline (m)           | `^` and `$` match at each line break.        |
| Dot matches newline (s) |                                              |
| Unicode (u)             | Code points, and `\p{...}` property escapes. |

Sticky (`y`) is deliberately absent: it interacts confusingly with the match
loop and is almost never what an interactive tester wants.

## Outputs

`output` is the replaced text in replace mode, and an offset-and-match listing
otherwise. `matches` is the structured form — index, whole match, positional
groups, named groups — for wiring into another node.

A group that did not participate in the match is `undefined` at runtime. The DOM
types model the match as `string[]`, which is simply not true; the code corrects
that and reports such groups as `null`, because JSON has no `undefined` and the
hole has to survive the trip out of the worker.

## Tests

`regex.test.ts` covers compilation failures, offsets, positional and named
groups, the zero-length-match guard, the match limit, replacement with group
references, and the pathological case described above.
