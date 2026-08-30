/**
 * Tools that no longer exist, and what they became.
 *
 * `markdown` (Markdown ⇄ HTML) and `html-text` (HTML → Markdown or plain text)
 * were merged into `text-convert`. Both of them converted HTML to Markdown, so
 * the palette offered two entries doing the same job - but saved canvases and
 * shared links out in the world still name them.
 *
 * ONE MODULE, because three different places need the same answer and they
 * must not drift: the persisted-graph migration, the share-link migration, and
 * the tests that prove both. A second copy of this mapping would be a bug
 * waiting for whichever copy someone forgot.
 */

/** The current id every retired tool maps to. */
export const REPLACEMENT_TOOL_ID = 'text-convert';

/**
 * The first input port of each retired tool.
 *
 * Needed by the v2 → v3 graph migration, which moves a node's single typed
 * `input` string onto the port it belonged to. That step reads the port name
 * from the live registry - and a retired id is not in the registry any more, so
 * without this the typed input would be silently dropped from exactly the nodes
 * this change is meant to rescue.
 */
const RETIRED_FIRST_PORT: Readonly<Record<string, string>> = {
  markdown: 'input',
  'html-text': 'input',
};

export function retiredFirstInputPort(toolId: string): string | undefined {
  return RETIRED_FIRST_PORT[toolId];
}

export function isRetiredToolId(toolId: unknown): toolId is keyof typeof RETIRED_FIRST_PORT {
  return typeof toolId === 'string' && toolId in RETIRED_FIRST_PORT;
}

/** Reads one option, returning undefined unless it is one of the allowed values. */
function pick<T extends string>(
  options: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = options[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function pickBoolean(options: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = options[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Drops undefined entries, so the schema's own defaults fill the gaps. */
function defined(entries: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

/**
 * Translates a retired tool's options into `text-convert`'s.
 *
 * Every value is re-read and re-checked rather than spread across, for two
 * reasons. Saved options are untrusted - a graph in localStorage can have been
 * edited by hand, and a share link is attacker-controlled - and the old shapes
 * carried keys (`direction`, `mode`) that mean nothing now. Emitting only
 * recognised keys with recognised values means the result cannot smuggle
 * anything through, and anything unrecognised falls back to a default.
 *
 * The format pairs map exactly, which is what made the merge worth doing:
 *
 *   markdown  / md-to-html  ->  markdown -> html
 *   markdown  / html-to-md  ->  html     -> markdown
 *   html-text / markdown    ->  html     -> markdown
 *   html-text / text        ->  html     -> text
 */
export function migrateRetiredOptions(
  toolId: string,
  raw: unknown,
): Record<string, unknown> | null {
  if (!isRetiredToolId(toolId)) return null;

  const options: Readonly<Record<string, unknown>> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  const shared = defined({
    bullet: pick(options, 'bullet', ['-', '*', '+']),
    emphasis: pick(options, 'emphasis', ['_', '*']),
    strong: pick(options, 'strong', ['*', '_']),
    fence: pick(options, 'fence', ['`', '~']),
    headingStyle: pick(options, 'headingStyle', ['atx', 'setext']),
    unsupported: pick(options, 'unsupported', ['keep', 'text', 'drop']),
    headingIds: pickBoolean(options, 'headingIds'),
    linkify: pickBoolean(options, 'linkify'),
    keepLinkUrls: pickBoolean(options, 'keepLinkUrls'),
    listMarker: pick(options, 'listMarker', ['-', '*', 'none']),
    tables: pick(options, 'tables', ['rows', 'drop']),
  });

  if (toolId === 'markdown') {
    // An unrecognised direction falls back to the old tool's own default.
    const toMarkdown = pick(options, 'direction', ['md-to-html', 'html-to-md']) === 'html-to-md';
    return {
      ...shared,
      source: toMarkdown ? 'html' : 'markdown',
      target: toMarkdown ? 'markdown' : 'html',
    };
  }

  // html-text only ever read HTML.
  const toText = pick(options, 'mode', ['markdown', 'text']) === 'text';
  return { ...shared, source: 'html', target: toText ? 'text' : 'markdown' };
}
