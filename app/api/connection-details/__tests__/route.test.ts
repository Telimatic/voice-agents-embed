// @vitest-environment node
//
// This route is server-only; running it under jsdom (the project default) fails, because
// jsdom's TextEncoder/Uint8Array live in a different realm than the one jose's `instanceof
// Uint8Array` check expects, and JWT signing throws. Node's environment gives it real
// platform globals.
//
// TLZ-561. The grant is fixed at mint: camera and microphone. SCREEN_SHARE is added at
// runtime by the worker (see the TLZ-561 runtime-widening spec), so no case here mocks any
// outbound call.
import { decodeJwt } from 'jose';
import { trackSourceToString } from 'livekit-server-sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackSource } from '@livekit/protocol';

const ENV = {
  LIVEKIT_URL: 'wss://example.livekit.cloud',
  LIVEKIT_API_KEY: 'test-api-key',
  LIVEKIT_API_SECRET: 'test-api-secret-needs-to-be-long-enough',
};

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

describe('POST /api/connection-details — the grant is fixed, never resolved', () => {
  it('mints camera + microphone only; SCREEN_SHARE is granted at runtime by the worker', async () => {
    const res = await POST(postRequest({ agentId: 'agent-1' }));
    assertResponse(res);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).not.toHaveProperty('capabilities');
    const grant = decodeGrant(data.participantToken);
    expect(grant.canPublishSources).toEqual([
      trackSourceToString(TrackSource.CAMERA),
      trackSourceToString(TrackSource.MICROPHONE),
    ]);
    expect(grant.canPublishSources).not.toContain(trackSourceToString(TrackSource.SCREEN_SHARE));
    expect(grant.canUpdateOwnMetadata).toBeFalsy();
  });

  it('never calls out before minting, whatever the environment says', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    process.env.DASHBOARD_EMBED_CONFIG_URL =
      'https://dashboard.example.com/api/embed/widget-config';
    process.env.EMBED_CONFIG_KEY_CURRENT = 'left-over-secret';
    try {
      const res = await POST(postRequest({ agentId: 'agent-1' }));
      assertResponse(res);
      expect(res.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.DASHBOARD_EMBED_CONFIG_URL;
      delete process.env.EMBED_CONFIG_KEY_CURRENT;
    }
  });

  it('mints without an agentId too (playground rooms)', async () => {
    const res = await POST(postRequest({}));
    assertResponse(res);
    const data = await res.json();
    expect(decodeGrant(data.participantToken).canPublishSources).toEqual([
      trackSourceToString(TrackSource.CAMERA),
      trackSourceToString(TrackSource.MICROPHONE),
    ]);
  });
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
