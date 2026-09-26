import sentinelFile from './spec/tz-sentinels.json';

import type { Zone } from './zones';

/**
 * WHICH RELEASE OF THE TZ DATABASE THIS BROWSER'S ANSWERS MATCH.
 *
 * No engine says. Measured at this commit: Playwright's Gecko and Node answer
 * like tzdata 2026b, and Playwright's WebKit like 2025a - so for
 * America/Vancouver in January 2027 one says -07:00 and the other -08:00, and
 * for Tehran in November 1978 one says +03:30 and the other +04:00. Both are
 * faithful to a real release; they are different releases. An answer that
 * depends on a zone's rules is therefore only as current as the browser's
 * copy of them, and the honest thing the tool can add is WHICH copy.
 *
 * Each sentinel is an instant one release changed, checked against all twenty
 * releases from 2022a to 2026d by `scripts/generate-tz-sentinels.py`. The
 * engine is asked the offset at each, and the answer is the last release
 * whose change it has, provided it has every change before that one too.
 */
export interface Sentinel {
  readonly release: string;
  readonly zone: string;
  readonly at: number;
  readonly before: number;
  readonly after: number;
}

export const SENTINELS: readonly Sentinel[] = sentinelFile.sentinels;

/** The newest release any sentinel knows about. */
export const NEWEST_KNOWN = SENTINELS[SENTINELS.length - 1]?.release ?? '';

export type Vintage =
  | { readonly kind: 'matches'; readonly release: string; readonly next: string | null }
  | { readonly kind: 'older'; readonly next: string }
  | { readonly kind: 'mixed'; readonly has: readonly string[]; readonly lacks: readonly string[] };

/**
 * Reads a vintage from zones, one per sentinel - or null for a zone the
 * engine does not know at all, which counts as lacking the change.
 */
export function readVintage(zoneFor: (name: string) => Zone | null): Vintage {
  const has: string[] = [];
  const lacks: string[] = [];
  for (const sentinel of SENTINELS) {
    const zone = zoneFor(sentinel.zone);
    const offset = zone === null ? null : zone.offsetAt(sentinel.at);
    (offset === sentinel.after ? has : lacks).push(sentinel.release);
  }

  const firstLack = SENTINELS.findIndex((sentinel) => lacks.includes(sentinel.release));
  const prefix = firstLack === -1 ? SENTINELS.length : firstLack;
  if (
    has.some((release) => SENTINELS.findIndex((sentinel) => sentinel.release === release) >= prefix)
  ) {
    return { kind: 'mixed', has, lacks };
  }
  if (prefix === 0) return { kind: 'older', next: SENTINELS[0]?.release ?? '' };
  return {
    kind: 'matches',
    release: SENTINELS[prefix - 1]?.release ?? '',
    next: SENTINELS[prefix]?.release ?? null,
  };
}

/** The sentence the report carries. */
export function describeVintage(vintage: Vintage): string {
  if (vintage.kind === 'matches') {
    return vintage.next === null
      ? `This browser's time zone data answers like tzdata ${vintage.release}, the newest release this tool knows of, or later.`
      : `This browser's time zone data answers like tzdata ${vintage.release}: it has that release's changes and not those of ${vintage.next}, which IANA published after it.`;
  }
  if (vintage.kind === 'older') {
    return `This browser's time zone data is older than tzdata ${vintage.next}, the oldest release this tool can recognise.`;
  }
  return `This browser's time zone data matches no single tzdata release: it has the changes of ${vintage.has.join(', ')} and not of ${vintage.lacks.join(', ')}.`;
}
