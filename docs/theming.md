# Theming

Four presets ship with Patchbay. Anyone can build more, in the editor on
[`/styleguide`](../src/routes/styleguide.lazy.tsx), and a theme they build is
the same kind of thing a preset is: an override of the semantic colour layer
and nothing else.

The token-layering rule — raw scale, semantic meanings, theme overrides, and
what may reference what — is in
[CONTRIBUTING.md](../CONTRIBUTING.md#the-token-layering-rule). This document is
about the editor, and about the decisions inside it that are not obvious from
the code.

## What a custom theme is

```ts
interface CustomTheme {
  id: string; // internal, never shown
  label: string; // what the user called it
  base: ThemeName; // the preset it inherits from
  overrides: Partial<Record<ThemedToken, string>>;
}
```

`applyTheme` sets `data-theme` to the base and writes each override as an
inline custom property on `<html>`. Inline styles beat the stylesheet, so a
custom theme is exactly "a preset plus some tokens" — the same mechanism the
presets use, with no second code path for components to know about.

The editor cannot invent a token. `THEMED_TOKENS` is the whole surface, it is
asserted against the real CSS by `themes.tokens.test.ts`, and
`tokenGroups.ts` is asserted to cover every entry of it. A token added to the
design system and forgotten in the editor is a failing test, not a token
nobody can reach.

## Stored values are hex, and only hex

This is a security boundary, not a formatting preference.

A CSS custom property will hold very nearly any token stream.
`--pb-accent: url(https://example.com/pixel.png)` is a perfectly valid custom
property, and the moment any rule uses that token in a `background` it becomes
a network request — out of an application whose whole premise is that it makes
none. `var(--something-else)` is equally valid and turns a colour into an
indirection somebody else chose.

So the stored form is an allow-list of one shape:

```ts
/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
```

Everything the user types is converted to that before it is stored — by the
editor, through the colour tool's parser — so hex constrains what can be
_written into CSS_, not what can be typed. `oklch(0.72 0.19 145)` is a fine
thing to type; `#43c251` is what is kept. `applyTheme` checks a second time,
because that one line is where a string becomes a stylesheet and no future
caller should be able to get it wrong. `pnpm check:browsers` asserts in Firefox
and WebKit that a `url()` typed into the editor never reaches the property.

## Two validators, on purpose

`customThemes.ts` reads the library from localStorage with hand-written guards.
`editor/themeFile.ts` reads an imported file with a Zod schema. They behave
differently, and that is the point:

|                       | Reading storage         | Reading a file                |
| --------------------- | ----------------------- | ----------------------------- |
| Whose data            | ours                    | a stranger's                  |
| An unknown token name | dropped, theme survives | the whole file is refused     |
| An unreadable colour  | dropped, theme survives | the whole file is refused     |
| A corrupt entry       | skipped, and counted    | refused with a reason         |
| Runs                  | at startup              | in the lazy /styleguide chunk |

Losing one colour out of twelve beats losing a theme somebody spent an evening
on, so the storage reader repairs and continues — and says how many entries it
had to skip, rather than silently shortening the list. A file is the opposite:
an unknown token means it was written for a different version of this
application, and applying the eleven tokens that did parse would produce a
theme its author never designed. Never apply a partially valid theme.

`themeFile.test.ts` asserts both behaviours side by side, in the same test, so
neither can quietly become the other.

There is a bundle argument underneath as well. The startup reader is in the
initial payload; Zod is 87 kB raw, measured, against 52 kB of remaining budget.
It would not fit, and it would mean every visitor downloading a validation
library to answer a question three `typeof` checks answer. But the two would
still be separate functions if Zod were free, because they are not being asked
the same question.

## Contrast is measured once, by one implementation

`themes.contrast.test.ts` holds the four presets to WCAG AA by resolving the
real CSS and measuring 33 pairs. A theme the user builds cannot be held to
anything by a test, because it does not exist when the test runs — so the
editor measures it live, continuously, as tokens change.

That is two consumers of one question, and the failure mode of answering it
twice is the worst kind: an editor that says AA and a suite that says fail,
with no way to tell which is lying. So the pair list and the arithmetic both
live in [`features/theme/contrast.ts`](../src/features/theme/contrast.ts), and
the test imports them. `contrast.test.ts` closes the loop directly: each preset
loaded into the editor as a custom theme must produce the same ratios,
pair for pair, that the preset test asserts.

Two smaller decisions inside it:

- **A translucent token has no ratio.** What `#ffffff80` reads against depends
  on what happens to be underneath, which is a layout question. Reporting
  "cannot say" is honest; compositing against the nominal background would
  produce a number that is right only sometimes.
- **The worst failure is ranked by shortfall, not by ratio.** A non-text pair
  at 2.9:1 is a hair under its 3:1 bar; a text pair at 3.5:1 is a whole point
  under its 4.5:1 one. The raw numbers disagree with which is worse, and the
  shortfall is the useful answer.

Tokens are resolved by parsing the stylesheet text rather than by
`getComputedStyle`. Both are correct in a browser; only one is correct
everywhere. A browser substitutes `var()` when it computes a custom property,
so `getComputedStyle` reads real colours there — but the same call under jsdom
returns the literal string `var(--raw-paper-600)`, which is not a colour and
cannot be measured. See the header of
[`lib/cssTokens.ts`](../src/lib/cssTokens.ts).

Saving a failing theme is allowed. It is the user's project and the user's
choice. Applying one raises a warning toast naming the number of pairs below
the minimum, and the editor's summary line carries a signal colour, a rule down
its leading edge and the words "5 of 33 pairs fail WCAG AA" — so the state is
carried by three things, none of which is colour alone.

## The editor is painted by the theme it edits

Deliberately. The alternative — an editor immune to the theme, drawn in fixed
colours — was considered and rejected.

The page exists so that editing a token shows you the whole design system
answering. An immune editor would be lying about what you are building, and
worse: it would let you ship a theme in which every ghost button in the
application is invisible, because the one panel where you could have noticed
was the one panel that did not use them. Making the editor a special case would
remove exactly the evidence the editor is for.

And immunity cannot be delivered anyway. No CSS can promise legibility to
somebody who has set every token to the same colour. What can be delivered is
that you can always get out:

- **Live preview** is a switch with a text label. Turning it off puts the page
  back to the selected theme without discarding a single edit.
- **Undo**, **Reset every token** and **Discard changes** are all buttons with
  words on them, reachable by keyboard, in a fixed order.
- No state in the editor is carried by colour alone — every contrast row has a
  glyph and a spoken verdict as well as a treatment.
- `forced-colors` mode replaces our palette with the user's own, which is the
  one guarantee of legibility that holds whatever the theme says.

## Sharing by URL: assessed, not implemented

Pipelines are shareable by link. Themes are not, and the recommendation is to
leave it that way for now.

**It would work.** A theme is 36 short colours; the existing share machinery —
bounded parameter, versioned payload, deflate, schema — would carry one in a
few hundred characters, and `themeFile.ts` already has the validator.

**The value is low.** Themes are personal in a way pipelines are not. A
pipeline link is how you show somebody a problem; a theme is how you like your
own screen. Export and import already cover the case of actually sending one,
with a file the recipient can read before they run it.

**The cost is a new hazard.** A pipeline link does not change the interface
before you have read it. A theme link repaints the entire UI the instant it
opens, which is a phishing-shaped primitive: make the destructive button look
like the safe one, make the warning toast the colour of the background. It
could also hand somebody an unreadable interface with no obvious way back.
Mitigating both means a preview-and-confirm step before anything is applied —
which is the friction the JSON file already has, minus the inspectability.

**If it is ever wanted**, it should be import-on-arrival with an explicit
preview and confirm, reusing `themeFileSchema` so there is still one validator.
The pieces are in place; what is missing is a reason.

## Storage keys

| Key                  | Holds                          |
| -------------------- | ------------------------------ |
| `patchbay:theme:v1`  | which theme is selected        |
| `patchbay:themes:v1` | the library of authored themes |

Two keys because they have two lifetimes: the selection changes every time
somebody clicks a radio button, the library when they author something. A write
to one can never scramble the other, and a format change to either is a rename
rather than a migration of corrupt data.

A draft is never persisted at all. It is what the screen is showing, not what
the user has chosen, and reloading mid-edit must not resurrect it.
