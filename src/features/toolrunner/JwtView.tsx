import { useState } from 'react';

import { ErrorIcon } from '@/components/Icon';
import { TextArea } from '@/components/TextArea';
import { isJsonObject, type JsonValue } from '@/features/registry/types';

import styles from './jwt.module.css';
import { RawPayload } from './RawPayload';
import { momentOf, type Moment } from './time';
import { ViewToggle } from './ViewToggle';

/**
 * A DECODED TOKEN, WITH THE VERDICT IMPOSSIBLE TO MISS.
 *
 * The tool already did the hard and careful part. It puts `signature` first in
 * its output, it refuses `alg: none` outright rather than treating it as an
 * algorithm, and it says in a full sentence when a signature was not checked
 * and why. All of that was then rendered as `JSON.stringify(..., 2)` in a
 * read-only textarea, where the most important line in the tool - "NOT
 * VERIFIED - no key supplied" - was a string value among other string values,
 * one line above a `header` object nobody scrolls past.
 *
 * THE HAZARD THIS VIEW IS ARRANGED AROUND. A JWT payload is base64, not
 * encryption. Anyone can rewrite one in fifteen seconds and it will still
 * decode perfectly. So the claims below are worth something only if the
 * signature was checked, and a decoder that displays them without that being
 * obvious is not a neutral tool - it is one that makes forged claims look
 * authoritative. Three rules follow, and none of them is negotiable:
 *
 *  1. THE VERDICT IS FIRST, AND IT IS THE LOUDEST THING ON SCREEN. A banner
 *     with a word, a rule, an icon and a sentence - not a badge, and not a
 *     line of small print under the claims.
 *
 *  2. "NOT VERIFIED" IS NEVER QUIET AND NEVER NEUTRAL. Five of the six
 *     outcomes mean the claims cannot be relied on, and all five are drawn as
 *     a warning or as danger. There is exactly one calm state, and it is the
 *     one where a real signature was checked against a real key. The no-key
 *     case in particular - overwhelmingly the common one, because most people
 *     paste a token simply to read it - is a WARNING rather than an absence.
 *
 *  3. THE CAVEAT TRAVELS WITH THE CLAIMS. A banner at the top is a banner you
 *     scroll past, so the payload's own heading carries the state with it and
 *     a sentence sits above the payload itself. A screen reader reaching the
 *     payload hears it there, in order, rather than having to remember
 *     something from four regions ago.
 *
 * Expiry is a SEPARATE question and is drawn separately. A perfectly valid
 * signature over a token that expired last Tuesday is still a token no server
 * will accept, and folding the two verdicts together loses one of them.
 *
 * The payload is read defensively rather than cast: it crossed the worker
 * boundary as plain JSON, so a future change to the tool's output shows up
 * here as a missing section instead of a crash inside a render.
 */

/* -------------------------------------------------------------------------- *
 * Reading the payload
 * -------------------------------------------------------------------------- */

/**
 * How far the reader may rely on what is below.
 *
 * Three values rather than the tool's five: this decides how loudly to speak,
 * and "nobody checked" and "we checked and it is a forgery" differ in wording
 * rather than in whether the claims can be believed.
 */
type Trust = 'verified' | 'unverified' | 'broken';

interface Signature {
  readonly algorithm: string | null;
  readonly trust: Trust;
  /** The heading word: "Signature verified", "Not verified", and so on. */
  readonly word: string;
  readonly summary: string;
  readonly detail: string;
}

interface Claims {
  readonly issuedAt: Moment | null;
  readonly notBefore: Moment | null;
  readonly expiresAt: Moment | null;
  readonly expired: boolean;
  readonly notYetValid: boolean;
}

interface Decoded {
  readonly signature: Signature;
  readonly header: JsonValue | null;
  readonly payload: JsonValue | null;
  readonly claims: Claims;
}

/**
 * The verdict word and its tone, keyed by the tool's own status.
 *
 * `no-key` and `unsupported` are WARNINGS, not neutral notes. They are the
 * states someone reaches by pasting a token to read it, which is the most
 * common thing anyone does with this tool and precisely the moment a decoder
 * is most tempted to look reassuring.
 */
const VERDICTS: Readonly<Record<string, { readonly trust: Trust; readonly word: string }>> = {
  verified: { trust: 'verified', word: 'Signature verified' },
  invalid: { trust: 'broken', word: 'Signature does not match' },
  rejected: { trust: 'broken', word: 'Rejected: unsigned token' },
  'no-key': { trust: 'unverified', word: 'Not verified' },
  unsupported: { trust: 'unverified', word: 'Not verified' },
};

const UNVERIFIED = { trust: 'unverified', word: 'Not verified' } as const;

function parseSignature(value: JsonValue | undefined): Signature {
  const object = value !== undefined && isJsonObject(value) ? value : null;
  const state = typeof object?.state === 'string' ? object.state : null;

  /*
   * FAILS CLOSED, twice.
   *
   * A payload from a build that predates `state`, or one carrying a state this
   * table has never heard of, falls back to the `verified` FLAG - and anything
   * other than exactly `true` there is unverified. Then a state claiming
   * `verified` over a flag that is not `true` is a contradiction, and the safe
   * reading of a contradiction is that nothing was checked. There is no route
   * to the calm treatment that does not pass through `verified === true`.
   */
  const fallback =
    object?.verified === true
      ? { trust: 'verified' as const, word: 'Signature verified' }
      : UNVERIFIED;

  const verdict = (state === null ? undefined : VERDICTS[state]) ?? fallback;
  const contradiction = verdict.trust === 'verified' && object?.verified !== true;
  const resolved = contradiction ? UNVERIFIED : verdict;

  return {
    algorithm: typeof object?.algorithm === 'string' ? object.algorithm : null,
    trust: resolved.trust,
    word: resolved.word,
    summary: typeof object?.status === 'string' ? object.status : 'The signature was not checked.',
    detail: typeof object?.detail === 'string' ? object.detail : '',
  };
}

/** A registered numeric claim, read from the payload rather than the report. */
function claimSeconds(payload: JsonValue | null, key: string): number | null {
  if (payload === null || !isJsonObject(payload)) return null;
  const value = payload[key];
  return typeof value === 'number' ? value : null;
}

function parseDecoded(value: JsonValue, override: number | null): Decoded | null {
  if (!isJsonObject(value)) return null;

  const payload = value.payload ?? null;
  const claims = value.claims !== undefined && isJsonObject(value.claims) ? value.claims : null;

  /*
   * THE CLOCK COMES FROM THE RUN, not from this render.
   *
   * The tool stamps `checkedAt` at the moment it decided `expired`, so every
   * relative phrase here is relative to the same instant that verdict was.
   * Reading `Date.now()` during a render would be both impure - a re-render
   * would silently change the text - and wrong: a tab left open for an hour
   * would count down past an `expired` flag that still says false.
   */
  const nowMs = override ?? (typeof claims?.checkedAt === 'number' ? claims.checkedAt : null);

  const moment = (key: string): Moment | null => {
    const seconds = claimSeconds(payload, key);
    return seconds === null ? null : momentOf(seconds, nowMs);
  };

  return {
    signature: parseSignature(value.signature),
    header: value.header ?? null,
    payload,
    claims: {
      issuedAt: moment('iat'),
      notBefore: moment('nbf'),
      expiresAt: moment('exp'),
      /*
       * Read from the tool's report rather than recomputed from `exp` here.
       * The tool applied the clock tolerance the user set, and a view that did
       * its own arithmetic would disagree with the tool at the margin - which
       * is the only place anybody looks.
       */
      expired: claims?.expired === true,
      notYetValid: claims?.notYetValid === true,
    },
  };
}

/** Registered string claims, in the order RFC 7519 lists them. */
const STRING_CLAIMS: readonly (readonly [string, string])[] = [
  ['iss', 'Issuer'],
  ['sub', 'Subject'],
  ['aud', 'Audience'],
  ['jti', 'Token ID'],
];

function stringClaims(payload: JsonValue | null): readonly (readonly [string, string, string])[] {
  if (payload === null || !isJsonObject(payload)) return [];

  return STRING_CLAIMS.flatMap(([key, label]) => {
    const value = payload[key];
    if (value === undefined || value === null) return [];
    /*
     * `aud` is legally a string OR an array of strings and tokens in the wild
     * carry both, so anything that is not a string is shown as its JSON rather
     * than as "[object Object]".
     */
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return [[key, label, text] as const];
  });
}

/* -------------------------------------------------------------------------- *
 * Pieces
 * -------------------------------------------------------------------------- */

function trustClass(trust: Trust): string {
  if (trust === 'verified') return styles.verdictOk ?? '';
  if (trust === 'broken') return styles.verdictBroken ?? '';
  return styles.verdictUnverified ?? '';
}

/** The verdict in one word, for the places the banner is not. */
const SHORT: Record<Trust, string> = {
  verified: 'verified',
  unverified: 'unverified',
  broken: 'not trustworthy',
};

function Verdict({ signature }: { readonly signature: Signature }) {
  return (
    /*
     * Not `role="alert"`. This is not an interruption - it is the first and
     * most prominent thing in the region, present from the moment the region
     * is, and an alert would fight the run's own status announcement for the
     * live region. It reads in order, which is where it belongs.
     */
    <div
      className={`${styles.verdict ?? ''} ${trustClass(signature.trust)}`}
      /*
       * The resolved trust as an attribute, so a test can assert WHICH of the
       * three treatments was chosen without matching a hashed CSS module class
       * - and so `check:browsers` can read the computed colours per state in a
       * real engine, which is the only place they exist at all.
       */
      data-trust={signature.trust}
    >
      <p className={styles.verdictHead}>
        {/*
          An icon on every state that is not a clean verification. The rule
          against carrying meaning by colour alone applies hardest to the one
          control in the app whose entire job is to say "do not trust this".
        */}
        {signature.trust === 'verified' ? null : <ErrorIcon size={16} />}
        <span className={styles.verdictWord}>{signature.word}</span>
        {signature.algorithm === null ? null : (
          <span className={styles.algorithm}>{signature.algorithm}</span>
        )}
      </p>
      <p className={styles.verdictSummary}>{signature.summary}</p>
      {signature.detail === '' ? null : <p className={styles.verdictDetail}>{signature.detail}</p>}
    </div>
  );
}

/** "3 days ago · 6 Sep 2026, 12:00 GMT", or just the absolute half. */
function when(moment: Moment): string {
  return moment.relative === null ? moment.absolute : `${moment.relative} · ${moment.absolute}`;
}

/**
 * Expiry, as its own verdict.
 *
 * A token whose signature verifies and whose `exp` passed last Tuesday is
 * still a token every server will refuse, and reporting only the signature
 * sends someone looking for the wrong bug. Nothing is drawn when the token
 * carries no time claims at all: a token with no `exp` has not "not expired",
 * it simply never said.
 */
function Validity({ claims }: { readonly claims: Claims }) {
  /*
   * `data-validity` for the same reason the verdict carries `data-trust`: the
   * strip deliberately repeats what the claims table also says, so a test
   * asserting "the token is reported as expired" has to be able to name the
   * VERDICT rather than matching text that legitimately appears twice.
   */
  if (claims.expired && claims.expiresAt) {
    return (
      <p className={`${styles.validity ?? ''} ${styles.validityBad ?? ''}`} data-validity="expired">
        <ErrorIcon size={14} />
        <strong>Expired</strong> {when(claims.expiresAt)}
      </p>
    );
  }

  if (claims.notYetValid && claims.notBefore) {
    return (
      <p className={`${styles.validity ?? ''} ${styles.validityBad ?? ''}`} data-validity="not-yet">
        <ErrorIcon size={14} />
        <strong>Not valid yet</strong> — usable {when(claims.notBefore)}
      </p>
    );
  }

  if (claims.expiresAt) {
    return (
      <p className={styles.validity} data-validity="live">
        <strong>Expires</strong> {when(claims.expiresAt)}
      </p>
    );
  }

  return null;
}

/** One time claim: the moment in words, the epoch integer beside it. */
function TimeRow({
  label,
  moment,
  claim,
}: {
  readonly label: string;
  readonly moment: Moment;
  readonly claim: string;
}) {
  return (
    <tr>
      <th scope="row" className={styles.rowHead}>
        {label} <span className={styles.claimKey}>{claim}</span>
      </th>
      <td>
        {/*
          A real <time> element: the machine-readable instant is the datetime
          attribute, so what is on screen can be the readable form without the
          precise one being lost.
        */}
        <time dateTime={moment.iso}>{moment.absolute}</time>
        {moment.relative === null ? null : (
          <span className={styles.relative}> ({moment.relative})</span>
        )}
      </td>
      <td className={styles.raw}>{moment.epochSeconds}</td>
    </tr>
  );
}

/** Pretty JSON in a labelled, read-only box. Still the actual data. */
function JsonBlock({
  heading,
  note,
  value,
  label,
}: {
  readonly heading: string;
  readonly note: string | null;
  readonly value: JsonValue;
  readonly label: string;
}) {
  return (
    <div className={styles.block}>
      <h3 className={styles.blockHead}>{heading}</h3>
      {note === null ? null : <p className={styles.untrusted}>{note}</p>}
      <TextArea
        className={styles.json}
        aria-label={label}
        value={JSON.stringify(value, null, 2)}
        readOnly
        spellCheck={false}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * View
 * -------------------------------------------------------------------------- */

export interface JwtViewProps {
  readonly value: JsonValue;
  readonly label: string;
  readonly baseFilename: string;
  readonly onCopy: (text: string) => void;
  readonly onDownload: (blob: Blob, filename: string) => void;
  /**
   * Overrides the run's own `checkedAt`. Tests only: the tool stamps the
   * moment it checked the token, and that is the clock this view uses.
   */
  readonly now?: number;
}

export function JwtView({ value, label, baseFilename, onCopy, onDownload, now }: JwtViewProps) {
  const [view, setView] = useState<'decoded' | 'raw'>('decoded');
  const decoded = parseDecoded(value, now ?? null);
  if (!decoded) return <p className={styles.aside}>Nothing to show.</p>;

  const { signature, claims } = decoded;
  const strings = stringClaims(decoded.payload);
  const times = [
    claims.issuedAt === null ? null : (['Issued', claims.issuedAt, 'iat'] as const),
    claims.notBefore === null ? null : (['Not before', claims.notBefore, 'nbf'] as const),
    claims.expiresAt === null ? null : (['Expires', claims.expiresAt, 'exp'] as const),
  ].filter((row) => row !== null);

  /*
   * The sentence that travels with the payload. Present unless a real
   * signature was checked against a real key - so the common case of pasting a
   * token with no key gets it, which is the whole point of rule 3.
   */
  const caveat =
    signature.trust === 'verified'
      ? null
      : 'These claims are unverified. Anyone can rewrite a JWT payload, so without a checked signature they prove nothing about who issued them.';

  return (
    <section className={styles.wrapper} aria-label={label}>
      <ViewToggle
        label={label}
        value={view}
        onChange={setView}
        options={[
          { id: 'decoded', label: 'Decoded', status: 'Showing the decoded token' },
          { id: 'raw', label: 'Raw', status: 'Showing the raw JSON' },
        ]}
      />

      {/*
        THE VERDICT IS OUTSIDE THE TOGGLE, on purpose.

        Raw is the machine-readable half of the same output rather than a
        different output, and putting the trust verdict behind a view switch
        would mean one press turns a token the tool warned about into an
        unlabelled wall of claims. Keeping it there costs four lines and closes
        the one hole this whole tool exists to close.
      */}
      <Verdict signature={signature} />
      <Validity claims={claims} />

      {view === 'raw' ? (
        <RawPayload
          label={label}
          value={value}
          baseFilename={baseFilename}
          onCopy={onCopy}
          onDownload={onDownload}
        />
      ) : (
        <>
          {times.length === 0 && strings.length === 0 ? null : (
            <table className={styles.table}>
              <caption className={styles.hidden}>Registered claims</caption>
              <thead>
                <tr>
                  <th scope="col">Claim</th>
                  <th scope="col">Value</th>
                  {/* Named, because "raw" in this table means epoch seconds. */}
                  <th scope="col">Raw</th>
                </tr>
              </thead>
              <tbody>
                {times.map(([rowLabel, moment, claim]) => (
                  <TimeRow key={claim} label={rowLabel} moment={moment} claim={claim} />
                ))}
                {strings.map(([key, rowLabel, text]) => (
                  <tr key={key}>
                    <th scope="row" className={styles.rowHead}>
                      {rowLabel} <span className={styles.claimKey}>{key}</span>
                    </th>
                    <td className={styles.value} colSpan={2}>
                      {text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {decoded.header === null ? null : (
            <JsonBlock
              heading="Header"
              note={null}
              value={decoded.header}
              label={`${label} header`}
            />
          )}

          {decoded.payload === null ? null : (
            <JsonBlock
              heading={`Payload (${SHORT[signature.trust]})`}
              note={caveat}
              value={decoded.payload}
              label={`${label} payload`}
            />
          )}
        </>
      )}
    </section>
  );
}
