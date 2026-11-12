// @vitest-environment node
//
// TLZ-742 — the widget's check of the 5-minute web call session token the Dashboard mints
// (telzino-dashboard lib/web-call-sessions/token.ts). Same format, same secret; the known
// vector below is the exact string the Dashboard's own test expects it to mint.
import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { WebCallSessionTokenError, verifyWebCallSessionToken } from '../web-call-session-token';

const SECRET = 'test-secret';
const ORIGIN = 'https://portal.example.com';
const SESSION = '11111111-1111-1111-1111-111111111111';
const AGENT = '22222222-2222-2222-2222-222222222222';
const KNOWN_VECTOR =
  'eyJ0eXAiOiJ3ZWJfY2FsbF9zZXNzaW9uIiwic2lkIjoiMTExMTExMTEtMTExMS0xMTExLTExMTEtMTExMTExMTExMTExIiwiYWdlbnQiOiIyMjIyMjIyMi0yMjIyLTIyMjItMjIyMi0yMjIyMjIyMjIyMjIiLCJvcmlnaW4iOiJodHRwczovL3BvcnRhbC5leGFtcGxlLmNvbSIsImV4cCI6MjAwMDAwMDAwMH0.GQ9sLL4weTXKVXOLL13Wl7XAEnjsACTrtMLGynfZy94';

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${createHmac('sha256', secret).update(b64).digest('base64url')}`;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return e instanceof WebCallSessionTokenError ? e.code : `other:${String(e)}`;
  }
  return undefined;
}

describe('verifyWebCallSessionToken (widget side)', () => {
  it('accepts the token the Dashboard mints (known vector)', async () => {
    await expect(
      verifyWebCallSessionToken(KNOWN_VECTOR, ORIGIN, SECRET, 1_999_999_000)
    ).resolves.toEqual({
      sessionId: SESSION,
      agentId: AGENT,
    });
  });

  it('refuses it from another origin, or with no Origin header', async () => {
    expect(
      await codeOf(
        verifyWebCallSessionToken(KNOWN_VECTOR, 'https://evil.example.com', SECRET, 1_999_999_000)
      )
    ).toBe('origin_mismatch');
    expect(await codeOf(verifyWebCallSessionToken(KNOWN_VECTOR, null, SECRET, 1_999_999_000))).toBe(
      'origin_mismatch'
    );
  });

  it('refuses it once expired', async () => {
    expect(
      await codeOf(verifyWebCallSessionToken(KNOWN_VECTOR, ORIGIN, SECRET, 2_000_000_000))
    ).toBe('expired');
  });

  it('refuses another secret and a tampered payload', async () => {
    expect(
      await codeOf(verifyWebCallSessionToken(KNOWN_VECTOR, ORIGIN, 'other-secret', 1_999_999_000))
    ).toBe('bad_signature');
    const [, sig] = KNOWN_VECTOR.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        typ: 'web_call_session',
        sid: SESSION,
        agent: 'other',
        origin: ORIGIN,
        exp: 2_000_000_000,
      })
    ).toString('base64url');
    expect(
      await codeOf(verifyWebCallSessionToken(`${forged}.${sig}`, ORIGIN, SECRET, 1_999_999_000))
    ).toBe('bad_signature');
  });

  it('refuses malformed input', async () => {
    for (const bad of ['', 'no-dot', 'a.b.c', '.', 'abc.', 'abc.!!!']) {
      expect(await codeOf(verifyWebCallSessionToken(bad, ORIGIN, SECRET, 1_999_999_000))).toMatch(
        /^(malformed|bad_signature)$/
      );
    }
  });

  it('refuses a TLZ-468 embed token signed with the same secret', async () => {
    const embed = sign({ org: 'org-1', origin: ORIGIN, exp: 2_000_000_000 });
    expect(await codeOf(verifyWebCallSessionToken(embed, ORIGIN, SECRET, 1_999_999_000))).toBe(
      'wrong_type'
    );
  });
});
