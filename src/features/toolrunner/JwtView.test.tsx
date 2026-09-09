import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JsonValue } from '@/features/registry/types';
import { encodeBase64, textToBytes } from '@/lib/base64';
import { expectNoAxeViolations } from '@/lib/testing/axe';
import jwtTool from '@/tools/jwt-decode';
import { jwtDefaultOptions, type JwtOptions } from '@/tools/jwt-decode/options';

import { JwtView } from './JwtView';

/**
 * These tests are about ONE thing, and it is not layout.
 *
 * A JWT payload is base64 and not encryption, so anyone can rewrite one and it
 * will still decode perfectly. The entire safety of a decoder rests on the
 * reader knowing whether the signature was checked - and the failure mode is
 * not a crash or a wrong number, it is a screen that looks fine and quietly
 * invites someone to believe a forgery. Nothing here can be checked by looking
 * at it once, which is precisely why each case is written down.
 */

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

/*
 * THE VIEW'S CLOCK AND THE TOOL'S CLOCK HAVE TO BE THE SAME CLOCK.
 *
 * `JwtView` takes `now` as a prop, so the rendering was already pinned. The
 * `decode` helper below runs the REAL tool, which reads `Date.now()` to decide
 * whether a token has expired - so the two disagreed by however long it had
 * been since this file was written, and every `exp`/`nbf` case written
 * relative to NOW quietly went stale. Two of them started failing when the
 * real date walked past 2026-09-06: a token whose `nbf` was "NOW + 2 hours"
 * became usable, and one expiring "in 1 hour" became expired.
 *
 * Pinning `Date.now` rather than the whole timer system: nothing here needs
 * fake timers, and swapping them in under an async suite is a much larger
 * change than the one fact this needs.
 */
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function b64url(text: string): string {
  return encodeBase64(textToBytes(text), { urlSafe: true, padding: false, wrapAt: 0 });
}

/** A compact JWT with whatever header, payload and signature segment is wanted. */
function tokenOf(header: JsonValue, payload: JsonValue, signature = 'bm90LWEtc2ln'): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${signature}`;
}

/** A genuine HS256 signature, for the one path that is allowed to be calm. */
async function signHs256(signingInput: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textToBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, textToBytes(signingInput));
  return encodeBase64(new Uint8Array(signature), { urlSafe: true, padding: false, wrapAt: 0 });
}

/**
 * The real tool's real output, so the view is tested against what it gets
 * rather than against a hand-written idea of it.
 */
async function decode(token: string, overrides: Partial<JwtOptions> = {}): Promise<JsonValue> {
  const result = await jwtTool.run({
    inputs: { input: { type: 'text', text: token } },
    options: { ...jwtDefaultOptions, ...overrides },
    context: { signal: new AbortController().signal, reportProgress: () => undefined },
  });

  if (!result.ok) throw new Error(result.error.message);
  const output = result.value.output;
  if (output?.type !== 'json') throw new Error('expected a JSON output');
  return output.data;
}

function renderToken(value: JsonValue) {
  const onCopy = vi.fn();
  const onDownload = vi.fn();
  const result = render(
    <JwtView
      value={value}
      label="JWT Decoded"
      baseFilename="jwt-decode"
      onCopy={onCopy}
      onDownload={onDownload}
      now={NOW}
    />,
  );
  return { ...result, onCopy, onDownload };
}

/** The verdict banner, found by the attribute that says which one it is. */
function verdict(): HTMLElement {
  const node = document.querySelector('[data-trust]');
  if (!(node instanceof HTMLElement)) throw new Error('no verdict banner rendered');
  return node;
}

describe('JwtView: the signature verdict', () => {
  /*
   * THE REASON THIS VIEW EXISTS.
   *
   * "NOT VERIFIED - no key supplied, so the HS256 signature was not checked."
   * was rendered as a string value inside `JSON.stringify(..., 2)`, one line
   * above a `header` object, in a read-only textarea. The tool had done the
   * work; the presentation threw it away.
   */
  it('leads with the verdict, above the claims it qualifies', async () => {
    renderToken(await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada' })));

    const banner = verdict();
    const table = screen.getByRole('table');

    expect(banner).toHaveTextContent('Not verified');
    expect(banner.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /*
   * THE RULE THAT MATTERS MOST. "Nobody checked this" is the state a decoder
   * reaches by default - most people paste a token simply to read it - and it
   * is exactly the state a decoder is most tempted to draw as an absence. An
   * absence is what makes a forged token look ordinary.
   */
  it('draws an unchecked signature as a warning, never as a neutral absence', async () => {
    renderToken(await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada' })));

    expect(verdict()).toHaveAttribute('data-trust', 'unverified');
    expect(screen.getByText(/no key supplied/)).toBeInTheDocument();
  });

  it('says a checked signature that does not match is a forgery, not a warning', async () => {
    renderToken(await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada' }), { key: 'wrong-secret' }));

    expect(verdict()).toHaveAttribute('data-trust', 'broken');
    expect(verdict()).toHaveTextContent('Signature does not match');
    expect(screen.getByText(/Do not trust these claims/)).toBeInTheDocument();
  });

  /*
   * `alg: none` is a real, historically exploited attack rather than an
   * algorithm. The tool refuses it outright; the view has to refuse it loudly.
   */
  it('shouts about alg: none rather than filing it under "not verified"', async () => {
    renderToken(await decode(tokenOf({ alg: 'none' }, { sub: 'ada' }, '')));

    expect(verdict()).toHaveAttribute('data-trust', 'broken');
    expect(verdict()).toHaveTextContent('Rejected: unsigned token');
    expect(screen.getByText(/attacker-controlled/)).toBeInTheDocument();
  });

  it('is calm only when a real signature was checked against a real key', async () => {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ sub: 'ada' }));
    const signature = await signHs256(`${header}.${payload}`, 'topsecret');

    renderToken(await decode(`${header}.${payload}.${signature}`, { key: 'topsecret' }));

    expect(verdict()).toHaveAttribute('data-trust', 'verified');
    expect(verdict()).toHaveTextContent('Signature verified');
  });
});

describe('JwtView: failing closed', () => {
  /*
   * The payload crossed the worker boundary as plain JSON and the view narrows
   * it back with checks. Every one of these is a route by which a malformed or
   * out-of-date payload could reach the CALM treatment, and none of them may.
   */
  it('reports a payload from a build with no `state` field using the flag alone', () => {
    renderToken({
      signature: { algorithm: 'HS256', verified: false, status: 'NOT VERIFIED - old build' },
      header: { alg: 'HS256' },
      payload: { sub: 'ada' },
      claims: {},
    });

    expect(verdict()).toHaveAttribute('data-trust', 'unverified');
  });

  it('treats a state it has never heard of as unverified', () => {
    renderToken({
      signature: { algorithm: 'HS256', verified: false, state: 'probably-fine', status: 'hm' },
      header: {},
      payload: { sub: 'ada' },
      claims: {},
    });

    expect(verdict()).toHaveAttribute('data-trust', 'unverified');
  });

  /*
   * A contradiction: the state claims a verification the flag denies. The safe
   * reading of a contradiction is that nothing was checked, and there is no
   * route to the calm treatment that does not pass through `verified === true`.
   */
  it('refuses to look reassuring when the state and the flag disagree', () => {
    renderToken({
      signature: { algorithm: 'HS256', verified: false, state: 'verified', status: 'VERIFIED' },
      header: {},
      payload: { sub: 'ada' },
      claims: {},
    });

    expect(verdict()).toHaveAttribute('data-trust', 'unverified');
    expect(verdict()).toHaveTextContent('Not verified');
  });

  /*
   * The relative times come from the run's own `checkedAt`. A payload without
   * one still renders - the absolute time and the epoch integer are both
   * there - and simply says nothing it cannot know.
   */
  it('renders a payload from a build that stamped no clock', () => {
    render(
      <JwtView
        value={{
          signature: {
            algorithm: 'HS256',
            verified: false,
            state: 'no-key',
            status: 'NOT VERIFIED',
          },
          header: {},
          payload: { sub: 'ada', exp: 1_788_699_600 },
          claims: { expired: false },
        }}
        label="JWT Decoded"
        baseFilename="jwt-decode"
        onCopy={() => undefined}
        onDownload={() => undefined}
      />,
    );

    expect(document.querySelector('[data-validity]')).toHaveAttribute('data-validity', 'live');
    expect(screen.getByText('1788699600')).toBeInTheDocument();
    expect(screen.queryByText(/ago\)/)).not.toBeInTheDocument();
  });

  it('says nothing to show rather than throwing on a shape it does not know', () => {
    renderToken(['not', 'a', 'token']);
    expect(screen.getByText('Nothing to show.')).toBeInTheDocument();
  });

  it('renders a token carrying no signature section at all', () => {
    renderToken({ header: { alg: 'HS256' }, payload: { sub: 'ada' } });

    expect(verdict()).toHaveAttribute('data-trust', 'unverified');
    expect(screen.getByText('The signature was not checked.')).toBeInTheDocument();
  });
});

describe('JwtView: the caveat travels with the claims', () => {
  /*
   * A banner at the top is a banner you scroll past. Someone reading a long
   * payload - or a screen reader user arriving at the payload region directly
   * - has to be told there, in order, rather than being expected to remember
   * something from four regions ago.
   */
  it('marks the payload itself as unverified, not only the banner', async () => {
    renderToken(await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada' })));

    const heading = screen.getByRole('heading', { name: 'Payload (unverified)' });
    const caveat = screen.getByText(/These claims are unverified/);
    const box = screen.getByRole('textbox', { name: 'JWT Decoded payload' });

    // In this order: the heading, then the warning, then the data.
    expect(heading.compareDocumentPosition(caveat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(caveat.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('drops the caveat only for a token that really was verified', async () => {
    const header = b64url(JSON.stringify({ alg: 'HS256' }));
    const payload = b64url(JSON.stringify({ sub: 'ada' }));
    const signature = await signHs256(`${header}.${payload}`, 'topsecret');

    renderToken(await decode(`${header}.${payload}.${signature}`, { key: 'topsecret' }));

    expect(screen.getByRole('heading', { name: 'Payload (verified)' })).toBeInTheDocument();
    expect(screen.queryByText(/These claims are unverified/)).not.toBeInTheDocument();
  });

  /*
   * The verdict is deliberately OUTSIDE the toggle. Raw is the machine-readable
   * half of the same output, and one press must not turn a token the tool
   * warned about into an unlabelled wall of claims.
   */
  it('keeps the verdict on screen in the raw view', async () => {
    const user = userEvent.setup();
    renderToken(await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada' })));

    await user.click(screen.getByRole('button', { name: 'Raw' }));

    expect(screen.getByRole('textbox', { name: 'JWT Decoded raw' })).toBeInTheDocument();
    expect(verdict()).toHaveAttribute('data-trust', 'unverified');
  });
});

describe('JwtView: time claims', () => {
  it('gives every timestamp in words, and keeps the epoch integer beside it', async () => {
    const issued = Math.floor(NOW / 1000) - 3600;
    renderToken(await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada', iat: issued })));

    const row = screen.getByRole('rowheader', { name: /Issued/ }).closest('tr');
    expect(row?.textContent).toContain('1 hour ago');
    expect(row?.textContent).toContain(issued.toString());

    // The precise instant survives as the machine-readable attribute, so the
    // readable form on screen costs nothing.
    const time = row?.querySelector('time');
    expect(time).toHaveAttribute('dateTime', new Date(issued * 1000).toISOString());
  });

  /*
   * A signature is not a validity period. A token that verifies perfectly and
   * expired last Tuesday is still a token every server refuses, and reporting
   * only the signature sends somebody looking for the wrong bug.
   */
  it('flags an expired token separately from the signature verdict', async () => {
    const expired = Math.floor(NOW / 1000) - 3 * 86_400;
    renderToken(await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada', exp: expired })));

    // Scoped to the strip, because the claims table legitimately says the
    // same thing again as data. This assertion is about the VERDICT.
    const strip = document.querySelector('[data-validity]');
    expect(strip).toHaveAttribute('data-validity', 'expired');
    expect(strip).toHaveTextContent('Expired 3 days ago');
  });

  it('says when a token is not usable yet', async () => {
    const later = Math.floor(NOW / 1000) + 7200;
    renderToken(await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada', nbf: later })));

    expect(document.querySelector('[data-validity]')).toHaveAttribute('data-validity', 'not-yet');
  });

  it('states a future expiry as a fact rather than as an alarm', async () => {
    const later = Math.floor(NOW / 1000) + 3600;
    renderToken(await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada', exp: later })));

    const strip = document.querySelector('[data-validity]');
    expect(strip).toHaveAttribute('data-validity', 'live');
    expect(strip).toHaveTextContent('Expires in 1 hour');
  });

  /*
   * A token is attacker-controlled text. `"exp": 1e300` is not a date and must
   * produce a missing row rather than "Invalid Date" where a date belongs.
   */
  it('drops a timestamp no Date can represent instead of printing Invalid Date', async () => {
    renderToken(await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada', iat: 1e300 })));

    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: /Issued/ })).not.toBeInTheDocument();
  });

  it('shows a token with no registered claims at all without an empty table', async () => {
    renderToken(await decode(tokenOf({ alg: 'HS256' }, { hello: 'world' })));

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'JWT Decoded payload' })).toBeInTheDocument();
  });

  it('renders an audience that arrived as an array rather than a string', async () => {
    renderToken(await decode(tokenOf({ alg: 'HS256' }, { aud: ['one', 'two'] })));

    expect(screen.getByText('["one","two"]')).toBeInTheDocument();
  });
});

describe('JwtView: the payload stays reachable', () => {
  it('keeps the raw JSON one press away, with Copy and Download', async () => {
    const user = userEvent.setup();
    const value = await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada' }));
    const { onCopy, onDownload } = renderToken(value);

    expect(screen.getByRole('button', { name: 'Decoded' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByRole('textbox', { name: 'JWT Decoded raw' })).toHaveValue(
      JSON.stringify(value, null, 2),
    );

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(onCopy).toHaveBeenCalledWith(JSON.stringify(value, null, 2));

    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(onDownload).toHaveBeenCalledWith(expect.any(Blob), 'jwt-decode.json');
  });

  it('says which view is showing in words, not only as a pressed state', async () => {
    renderToken(await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada' })));

    expect(screen.getByRole('status')).toHaveTextContent('Showing the decoded token');
  });
});

describe('JwtView: accessibility', () => {
  it('has no axe violations for an unverified token', async () => {
    const { container } = renderToken(await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada' })));
    await expectNoAxeViolations(container);
  });

  it('has no axe violations for a rejected token with every claim populated', async () => {
    const seconds = Math.floor(NOW / 1000);
    const { container } = renderToken(
      await decode(
        tokenOf(
          { alg: 'none' },
          {
            iss: 'https://example.test',
            sub: 'ada',
            aud: ['one', 'two'],
            jti: 'abc-123',
            iat: seconds - 7200,
            nbf: seconds - 7200,
            exp: seconds - 3600,
          },
          '',
        ),
      ),
    );
    await expectNoAxeViolations(container);
  });

  it('has no axe violations in the raw view', async () => {
    const user = userEvent.setup();
    const { container } = renderToken(await decode(tokenOf({ alg: 'HS256' }, { sub: 'ada' })));

    await user.click(screen.getByRole('button', { name: 'Raw' }));
    await expectNoAxeViolations(container);
  });
});
