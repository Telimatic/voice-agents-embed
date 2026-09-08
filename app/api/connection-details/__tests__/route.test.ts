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

beforeEach(() => {
  vi.unstubAllGlobals();
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
    expect(grant.canUpdateOwnMetadata).toBe(true);
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
    expect(grant.canUpdateOwnMetadata).toBe(true);
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
    expect(grant.canUpdateOwnMetadata).toBe(true);

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
    expect(grant.canUpdateOwnMetadata).toBe(true);
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
    expect(grant.canUpdateOwnMetadata).toBe(true);

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
    expect(grant.canUpdateOwnMetadata).toBe(true);
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
      expect(grant.canUpdateOwnMetadata).toBe(true);

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
});
