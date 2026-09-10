// @vitest-environment node
//
// This route is server-only; running it under jsdom (the project default) fails, because
// jsdom's TextEncoder/Uint8Array live in a different realm than the one jose's `instanceof
// Uint8Array` check expects, and JWT signing throws. Node's environment gives it real
// platform globals.
//
// TLZ-561. Exercises the token route with the dashboard's widget-config fetch mocked:
// screenshare on/off restricts canPublishSources in the minted grant, and every way the
// dashboard call can fail resolves to a working, audio-only token rather than a broken
// call. Grants are asserted by decoding the minted JWT (jose), not by trusting the SDK.
import { createHmac } from 'crypto';
import { decodeJwt } from 'jose';
import { trackSourceToString } from 'livekit-server-sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackSource } from '@livekit/protocol';

const ENV = {
  LIVEKIT_URL: 'wss://example.livekit.cloud',
  LIVEKIT_API_KEY: 'test-api-key',
  LIVEKIT_API_SECRET: 'test-api-secret-needs-to-be-long-enough',
  DASHBOARD_EMBED_CONFIG_URL: 'https://dashboard.example.com/api/embed/widget-config',
  EMBED_CONFIG_KEY_CURRENT: 'test-shared-secret',
};

/**
 * Independent reimplementation of telzino-dashboard's `macInput` + HMAC (verified by hand
 * against that repo's real `signEmbedConfigRequest` for several vectors, including a body
 * containing raw digit-newline bytes, before this test was written). Kept separate from
 * lib/embed-config-client.ts's own implementation so this test still fails if that
 * implementation regresses, rather than trivially agreeing with itself.
 */
function expectedSignature(body: string, timestamp: number, key: string): string {
  const ts = String(timestamp);
  const bodyBuf = Buffer.from(body, 'utf8');
  const macInput = Buffer.concat([
    Buffer.from(`${ts.length}\n${ts}`, 'utf8'),
    Buffer.from(`${bodyBuf.length}\n`, 'utf8'),
    bodyBuf,
  ]);
  return createHmac('sha256', key).update(macInput).digest('base64url');
}

type DecodedVideoGrant = {
  room?: string;
  roomJoin?: boolean;
  canPublish?: boolean;
  canPublishData?: boolean;
  canSubscribe?: boolean;
  canUpdateOwnMetadata?: boolean;
  canPublishSources?: string[];
};

function decodeGrant(token: string): DecodedVideoGrant {
  const payload = decodeJwt(token) as { video?: DecodedVideoGrant };
  if (!payload.video) throw new Error('token carries no video grant');
  return payload.video;
}

/** Participant attributes stamped into the token itself, rather than written by the
 *  participant after joining — see createParticipantToken for why that distinction is
 *  the whole point. */
function decodeAttributes(token: string): Record<string, string> {
  const payload = decodeJwt(token) as { attributes?: Record<string, string> };
  return payload.attributes ?? {};
}

function postRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/connection-details', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** POST's return type is `NextResponse | undefined` (it falls through on a non-Error
 *  throw); every test here expects a real response, so assert that up front instead of
 *  letting TypeScript treat `res` as possibly undefined at every call site. */
function assertResponse(
  res: Awaited<ReturnType<typeof POST>>
): asserts res is NonNullable<typeof res> {
  if (!res) throw new Error('route returned no response');
}

let POST: typeof import('../route').POST;

beforeAll(async () => {
  Object.assign(process.env, ENV);
  ({ POST } = await import('../route'));
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  // The config client memoises per agent id for 30s (lib/embed-config-client.ts). Every
  // case here reuses 'agent-1', so without this each test would answer from the previous
  // test's fixture instead of its own.
  const { __clearScreenshareConfigMemo } = await import('@/lib/embed-config-client');
  __clearScreenshareConfigMemo();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('POST /api/connection-details — screenshare capability', () => {
  it('enabled: grant carries microphone + screen_share, capabilities.screenshare is true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          organization_id: 'org-1',
          screenshare: {
            enabled: true,
            reason: 'ok',
            config: { allowed_surfaces: ['browser', 'window'] },
          },
        })
      )
    );

    const res = await POST(postRequest({ agentId: 'agent-1' }));
    assertResponse(res);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.capabilities).toEqual({
      screenshare: true,
      allowedSurfaces: ['browser', 'window'],
    });

    const grant = decodeGrant(data.participantToken);
    // CAMERA must survive alongside SCREEN_SHARE: this feature gates screenshare only,
    // and must not narrow an unrelated capability that already worked.
    expect(grant.canPublishSources).toEqual([
      trackSourceToString(TrackSource.CAMERA),
      trackSourceToString(TrackSource.MICROPHONE),
      trackSourceToString(TrackSource.SCREEN_SHARE),
    ]);
    expect(grant.canUpdateOwnMetadata).toBeFalsy(); // must never be granted — see decodeAttributes tests
  });

  it('disabled: grant carries camera + microphone (no screen_share), capabilities.screenshare is false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          organization_id: 'org-1',
          screenshare: { enabled: false, reason: 'account_locked' },
        })
      )
    );

    const res = await POST(postRequest({ agentId: 'agent-1' }));
    assertResponse(res);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.capabilities.screenshare).toBe(false);

    const grant = decodeGrant(data.participantToken);
    // CAMERA must survive even though screenshare is off: only SCREEN_SHARE is gated.
    expect(grant.canPublishSources).toEqual([
      trackSourceToString(TrackSource.CAMERA),
      trackSourceToString(TrackSource.MICROPHONE),
    ]);
    expect(grant.canPublishSources).not.toContain(trackSourceToString(TrackSource.SCREEN_SHARE));
    expect(grant.canUpdateOwnMetadata).toBeFalsy(); // must never be granted — see decodeAttributes tests
  });

  /**
   * TLZ-561 final review M-1. `sanitizeAllowedSurfaces` drops every value it does not
   * recognize; before the fix, an `allowed_surfaces` whose entries were ALL unrecognized
   * became `[]`, and `[]` is falsy-length — so `preferredSurface`/`negotiateSurfaces`
   * (hooks/use-screenshare-session.ts) read it as "no policy" and fell back to
   * DEFAULT_ALLOWED_SURFACES, i.e. browser AND window AND monitor. A narrowing function
   * that widens to the most permissive set on bad input is the one fail-OPEN path in a
   * file whose every other branch fails closed.
   *
   * Asserted through the ROUTE rather than against sanitizeAllowedSurfaces directly,
   * because the consequence that matters is the minted grant: canPublishSources derives
   * SCREEN_SHARE from `enabled`, never from the surface list, so a widened surface list
   * arrived with a token that already authorized the capture.
   */
  it.each([
    ['every entry unrecognized', ['desktop', 'tab', 'application']],
    ['a single unrecognized entry', ['desktop']],
    ['an empty list', []],
    ['a list of non-strings', [1, null, { surface: 'browser' }]],
  ])(
    'enabled with an unusable allowed_surfaces (%s): reports disabled and withholds SCREEN_SHARE, never the full surface set',
    async (_label, allowed_surfaces) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse({
            organization_id: 'org-1',
            screenshare: { enabled: true, reason: 'ok', config: { allowed_surfaces } },
          })
        )
      );

      const res = await POST(postRequest({ agentId: 'agent-1' }));
      assertResponse(res);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.capabilities.screenshare).toBe(false);
      // Specifically NOT the permissive fallback: this is the exact widening being pinned.
      expect(data.capabilities.allowedSurfaces).toBeUndefined();

      const grant = decodeGrant(data.participantToken);
      expect(grant.canPublishSources).not.toContain(trackSourceToString(TrackSource.SCREEN_SHARE));
      // The call itself is untouched — a policy this build cannot read costs the feature,
      // never the conversation.
      expect(grant.canPublishSources).toEqual([
        trackSourceToString(TrackSource.CAMERA),
        trackSourceToString(TrackSource.MICROPHONE),
      ]);
    }
  );

  it('enabled with a PARTLY unrecognized allowed_surfaces: keeps the recognized ones and stays on', async () => {
    // The narrowing behaviour must survive the fix above: dropping unknown entries is not
    // the same as refusing the whole list, and a future surface name this build predates
    // must not switch the feature off for surfaces it does understand.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          organization_id: 'org-1',
          screenshare: {
            enabled: true,
            reason: 'ok',
            config: { allowed_surfaces: ['browser', 'hologram'] },
          },
        })
      )
    );

    const res = await POST(postRequest({ agentId: 'agent-1' }));
    assertResponse(res);
    const data = await res.json();

    expect(data.capabilities.screenshare).toBe(true);
    expect(data.capabilities.allowedSurfaces).toEqual(['browser']);
    expect(decodeGrant(data.participantToken).canPublishSources).toContain(
      trackSourceToString(TrackSource.SCREEN_SHARE)
    );
  });

  it('dashboard unreachable: still mints an audio-only token, 200, and logs a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed: ECONNREFUSED')));

    const res = await POST(postRequest({ agentId: 'agent-1' }));
    assertResponse(res);

    // A screenshare outage must never cost the caller their voice call.
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.capabilities.screenshare).toBe(false);
    expect(typeof data.participantToken).toBe('string');

    const grant = decodeGrant(data.participantToken);
    expect(grant.canPublishSources).toEqual([
      trackSourceToString(TrackSource.CAMERA),
      trackSourceToString(TrackSource.MICROPHONE),
    ]);
    expect(grant.canUpdateOwnMetadata).toBeFalsy(); // must never be granted — see decodeAttributes tests

    expect(warnSpy).toHaveBeenCalled();
  });

  it('dashboard slow: a fetch that never settles is abandoned after the timeout, and behaves as disabled', async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    // Stand in for the real AbortSignal.timeout, whose internal timer fake timers cannot
    // see, with one built from a plain setTimeout that they can.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      })
    );

    const resPromise = POST(postRequest({ agentId: 'agent-1' }));
    await vi.advanceTimersByTimeAsync(1_500);
    const res = await resPromise;
    assertResponse(res);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.capabilities.screenshare).toBe(false);

    const grant = decodeGrant(data.participantToken);
    expect(grant.canPublishSources).toEqual([
      trackSourceToString(TrackSource.CAMERA),
      trackSourceToString(TrackSource.MICROPHONE),
    ]);
    expect(grant.canUpdateOwnMetadata).toBeFalsy(); // must never be granted — see decodeAttributes tests
  });

  it('missing agentId: audio-only, dashboard never called', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(postRequest({}));
    assertResponse(res);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.capabilities.screenshare).toBe(false);

    const grant = decodeGrant(data.participantToken);
    expect(grant.canPublishSources).toEqual([
      trackSourceToString(TrackSource.CAMERA),
      trackSourceToString(TrackSource.MICROPHONE),
    ]);
    expect(grant.canUpdateOwnMetadata).toBeFalsy(); // must never be granted — see decodeAttributes tests

    // No agentId to ask about means there is nothing to fetch: fail closed locally
    // rather than making a request that could never succeed.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dashboard returns non-OK (e.g. 401 after a key rotation): audio-only, 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401)));

    const res = await POST(postRequest({ agentId: 'agent-1' }));
    assertResponse(res);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.capabilities.screenshare).toBe(false);

    const grant = decodeGrant(data.participantToken);
    expect(grant.canPublishSources).toEqual([
      trackSourceToString(TrackSource.CAMERA),
      trackSourceToString(TrackSource.MICROPHONE),
    ]);
    expect(grant.canUpdateOwnMetadata).toBeFalsy(); // must never be granted — see decodeAttributes tests
  });

  it('not_configured: DASHBOARD_EMBED_CONFIG_URL / EMBED_CONFIG_KEY_CURRENT unset (the state of every environment today), audio-only, dashboard never called', async () => {
    const savedUrl = process.env.DASHBOARD_EMBED_CONFIG_URL;
    const savedKey = process.env.EMBED_CONFIG_KEY_CURRENT;
    delete process.env.DASHBOARD_EMBED_CONFIG_URL;
    delete process.env.EMBED_CONFIG_KEY_CURRENT;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      const res = await POST(postRequest({ agentId: 'agent-1' }));
      assertResponse(res);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.capabilities.screenshare).toBe(false);

      const grant = decodeGrant(data.participantToken);
      expect(grant.canPublishSources).toEqual([
        trackSourceToString(TrackSource.CAMERA),
        trackSourceToString(TrackSource.MICROPHONE),
      ]);
      expect(grant.canUpdateOwnMetadata).toBeFalsy(); // must never be granted — see decodeAttributes tests

      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.DASHBOARD_EMBED_CONFIG_URL = savedUrl;
      process.env.EMBED_CONFIG_KEY_CURRENT = savedKey;
    }
  });

  it('signs the outgoing request to the dashboard over the exact body sent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        organization_id: null,
        screenshare: { enabled: false, reason: 'not_configured' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await POST(postRequest({ agentId: 'agent-signed' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENV.DASHBOARD_EMBED_CONFIG_URL);

    const headers = init.headers as Record<string, string>;
    const timestampHeader = headers['x-embed-timestamp'];
    const signatureHeader = headers['x-embed-signature'];
    expect(timestampHeader).toMatch(/^\d+$/);
    // Must be unix SECONDS, not milliseconds: the dashboard's 60-second skew window
    // would reject every request sent in milliseconds (off by a factor of 1000), and a
    // bare digit-string regex would not have noticed.
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(Number(timestampHeader)).toBeGreaterThan(nowSeconds - 5);
    expect(Number(timestampHeader)).toBeLessThan(nowSeconds + 5);
    expect(signatureHeader).toBeTruthy();

    const sentBody = init.body as string;
    expect(JSON.parse(sentBody)).toEqual({ agentId: 'agent-signed' });

    const expected = expectedSignature(
      sentBody,
      Number(timestampHeader),
      ENV.EMBED_CONFIG_KEY_CURRENT
    );
    expect(signatureHeader).toBe(expected);

    // Signature is bound to the body: changing even one byte must not still verify.
    const tamperedSignature = expectedSignature(
      sentBody + ' ',
      Number(timestampHeader),
      ENV.EMBED_CONFIG_KEY_CURRENT
    );
    expect(tamperedSignature).not.toBe(signatureHeader);
  });

  describe('capability attribute (A4) — minted, never client-written', () => {
    it('stamps telzino.screenshare.capable from the request body', async () => {
      const { POST } = await import('../route');
      const res = await POST(postRequest({ agentId: 'agent-1', capable: true }));
      assertResponse(res);
      const { participantToken } = (await res.json()) as { participantToken: string };

      expect(decodeAttributes(participantToken)).toEqual({ 'telzino.screenshare.capable': 'true' });
      expect(decodeGrant(participantToken).canUpdateOwnMetadata).toBeFalsy();
    });

    it("stamps 'false' when the browser reports it cannot capture", async () => {
      const { POST } = await import('../route');
      const res = await POST(postRequest({ agentId: 'agent-1', capable: false }));
      assertResponse(res);
      const { participantToken } = (await res.json()) as { participantToken: string };

      expect(decodeAttributes(participantToken)['telzino.screenshare.capable']).toBe('false');
    });

    it("stamps 'false' when the field is absent or not a boolean true", async () => {
      // Fail closed on junk: the agent must not be told a browser can capture because a
      // caller sent `capable: 'yes'`.
      const { POST } = await import('../route');
      for (const body of [{ agentId: 'agent-1' }, { agentId: 'agent-1', capable: 'yes' }]) {
        const res = await POST(postRequest(body));
        assertResponse(res);
        const { participantToken } = (await res.json()) as { participantToken: string };
        expect(decodeAttributes(participantToken)['telzino.screenshare.capable']).toBe('false');
      }
    });
  });

  describe('config memo (review I-2)', () => {
    it('asks the dashboard once per agent, not once per session start', async () => {
      // Every widget open on every customer site waits on this hop before the room
      // connects; the dashboard's own memo is per dashboard instance, not per embed host.
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          organization_id: 'org-1',
          screenshare: { enabled: true, reason: 'ok', config: { allowed_surfaces: ['browser'] } },
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      for (let i = 0; i < 3; i++) {
        const res = await POST(postRequest({ agentId: 'agent-memo-1' }));
        assertResponse(res);
        const data = await res.json();
        expect(data.capabilities.screenshare).toBe(true);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('memoises per agent, so one agent cannot answer for another', async () => {
      const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        const { agentId } = JSON.parse(init.body as string);
        return Promise.resolve(
          jsonResponse({
            organization_id: 'org-1',
            screenshare:
              agentId === 'agent-on'
                ? { enabled: true, reason: 'ok', config: { allowed_surfaces: ['browser'] } }
                : { enabled: false, reason: 'agent_disabled' },
          })
        );
      });
      vi.stubGlobal('fetch', fetchMock);

      const onRes = await POST(postRequest({ agentId: 'agent-on' }));
      assertResponse(onRes);
      expect((await onRes.json()).capabilities.screenshare).toBe(true);

      const offRes = await POST(postRequest({ agentId: 'agent-off' }));
      assertResponse(offRes);
      expect((await offRes.json()).capabilities.screenshare).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('memoises a failure too, so a dashboard outage is not re-dialled on every call', async () => {
      // The only stale direction is WITHHOLDING the feature, which is the safe one.
      const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', fetchMock);

      for (let i = 0; i < 3; i++) {
        const res = await POST(postRequest({ agentId: 'agent-down' }));
        assertResponse(res);
        expect((await res.json()).capabilities.screenshare).toBe(false);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
