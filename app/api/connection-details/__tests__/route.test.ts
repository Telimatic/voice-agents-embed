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

function postRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/connection-details', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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

    expect(decodeAttributes(participantToken)).toEqual({
      'telzino.screenshare.capable': 'true',
      'telzino.display.capable': 'false',
    });
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

describe('display capability attribute (TLZ-561) — minted, independent of capture', () => {
  it("stamps 'true' only for a boolean true, even when the browser cannot capture", async () => {
    const { POST } = await import('../route');
    const cases: [Record<string, unknown>, string][] = [
      [{ agentId: 'agent-1', capable: false, displayCapable: true }, 'true'],
      [{ agentId: 'agent-1' }, 'false'],
      [{ agentId: 'agent-1', displayCapable: 'yes' }, 'false'],
    ];
    for (const [body, expected] of cases) {
      const res = await POST(postRequest(body));
      assertResponse(res);
      const { participantToken } = (await res.json()) as { participantToken: string };
      expect(decodeAttributes(participantToken)['telzino.display.capable']).toBe(expected);
    }
  });
});

describe('client IP attribute (TLZ-706) — minted from Cloudflare, never from X-Forwarded-For', () => {
  async function mintToken(headers: Record<string, string>): Promise<string> {
    const res = await POST(postRequest({ agentId: 'agent-1' }, headers));
    assertResponse(res);
    return ((await res.json()) as { participantToken: string }).participantToken;
  }

  it('stamps telzino.client_ip from CF-Connecting-IP', async () => {
    const participantToken = await mintToken({ 'cf-connecting-ip': '203.0.113.45' });

    expect(decodeAttributes(participantToken)['telzino.client_ip']).toBe('203.0.113.45');
    expect(decodeGrant(participantToken).canUpdateOwnMetadata).toBeFalsy();
  });

  it('stamps nothing from a spoofed X-Forwarded-For alone', async () => {
    const participantToken = await mintToken({ 'x-forwarded-for': '1.1.1.1' });

    expect(Object.keys(decodeAttributes(participantToken))).not.toContain('telzino.client_ip');
  });

  it("Cloudflare's address wins over a spoofed X-Forwarded-For", async () => {
    const participantToken = await mintToken({
      'cf-connecting-ip': '203.0.113.45',
      'x-forwarded-for': '1.1.1.1',
    });

    expect(decodeAttributes(participantToken)['telzino.client_ip']).toBe('203.0.113.45');
  });
});

describe('web call session token (TLZ-742) — session id into room metadata, server-side only', () => {
  const SECRET = 'route-test-session-secret';
  const ORIGIN = 'https://portal.example.com';
  const SESSION = '11111111-1111-1111-1111-111111111111';
  const AGENT = '22222222-2222-2222-2222-222222222222';

  async function sessionToken(
    over: Record<string, unknown> = {},
    secret = SECRET
  ): Promise<string> {
    const { createHmac } = await import('crypto');
    const payload = {
      typ: 'web_call_session',
      sid: SESSION,
      agent: AGENT,
      origin: ORIGIN,
      exp: Math.floor(Date.now() / 1000) + 300,
      ...over,
    };
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${b64}.${createHmac('sha256', secret).update(b64).digest('base64url')}`;
  }

  function roomConfigOf(
    token: string
  ): { metadata?: string; agents?: { agentName?: string }[] } | undefined {
    return (
      decodeJwt(token) as { roomConfig?: { metadata?: string; agents?: { agentName?: string }[] } }
    ).roomConfig;
  }

  beforeEach(() => {
    process.env.WEB_CALL_SESSION_TOKEN_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.WEB_CALL_SESSION_TOKEN_SECRET;
  });

  it("writes the session id into the room metadata and uses the token's agent for the room", async () => {
    const res = await POST(
      postRequest({ sessionToken: await sessionToken(), capable: true }, { origin: ORIGIN })
    );
    assertResponse(res);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.roomName).toMatch(new RegExp(`^agent-${AGENT}-\\d+-[0-9a-f]{8}$`));
    const config = roomConfigOf(data.participantToken);
    expect(JSON.parse(config?.metadata ?? '{}')).toEqual({ telzino_web_call_session: SESSION });
    // No explicit dispatch: unnamed workers still get the job through LiveKit's default dispatch.
    expect(config?.agents ?? []).toEqual([]);
    const grant = decodeGrant(data.participantToken);
    expect(grant.room).toBe(data.roomName);
    expect(grant.canUpdateOwnMetadata).toBeFalsy();
    expect((grant as Record<string, unknown>).roomAdmin).toBeFalsy();
    // Exactly the usual attributes: the session id never goes into participant attributes.
    expect(decodeAttributes(data.participantToken)).toEqual({
      'telzino.screenshare.capable': 'true',
      'telzino.display.capable': 'false',
    });
  });

  it('keeps the named-worker passthrough alongside the metadata', async () => {
    const res = await POST(
      postRequest(
        { sessionToken: await sessionToken(), room_config: { agents: [{ agent_name: 'dev-x' }] } },
        { origin: ORIGIN }
      )
    );
    assertResponse(res);
    const config = roomConfigOf((await res.json()).participantToken);
    expect(config?.agents?.[0]?.agentName).toBe('dev-x');
    expect(JSON.parse(config?.metadata ?? '{}')).toEqual({ telzino_web_call_session: SESSION });
  });

  it.each([
    ['another website', async () => sessionToken(), 'https://evil.example.com', 'origin_mismatch'],
    ['no Origin header', async () => sessionToken(), undefined, 'origin_mismatch'],
    [
      'an expired token',
      async () => sessionToken({ exp: Math.floor(Date.now() / 1000) - 1 }),
      ORIGIN,
      'expired',
    ],
    ['another secret', async () => sessionToken({}, 'other-secret'), ORIGIN, 'bad_signature'],
    ['a non-string token', async () => 42 as unknown as string, ORIGIN, 'malformed'],
  ])('401s on %s and mints nothing', async (_label, makeToken, origin, reason) => {
    const res = await POST(
      postRequest({ sessionToken: await makeToken() }, origin ? { origin } : {})
    );
    assertResponse(res);
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.json();
    expect(body).toEqual({ error: 'invalid_session_token', reason });
    expect(body).not.toHaveProperty('participantToken');
  });

  it('400s when the body names a different agent than the token', async () => {
    const res = await POST(
      postRequest(
        { sessionToken: await sessionToken(), agentId: 'other-agent' },
        { origin: ORIGIN }
      )
    );
    assertResponse(res);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('agent_mismatch');
  });

  it('treats the agent id in the body case-insensitively', async () => {
    const lettered = 'abcdef12-3456-4789-8abc-def123456789';
    const res = await POST(
      postRequest(
        { sessionToken: await sessionToken({ agent: lettered }), agentId: lettered.toUpperCase() },
        { origin: ORIGIN }
      )
    );
    assertResponse(res);
    expect(res.status).toBe(200);
  });

  it.each([123, { id: AGENT }, [AGENT]])(
    'refuses a non-text agent id in the body as agent_mismatch (%j)',
    async (agentId) => {
      const res = await POST(
        postRequest({ sessionToken: await sessionToken(), agentId }, { origin: ORIGIN })
      );
      assertResponse(res);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('agent_mismatch');
    }
  );

  it('accepts the same agent id in the body (popup sends data-agent-id too)', async () => {
    const res = await POST(
      postRequest({ sessionToken: await sessionToken(), agentId: AGENT }, { origin: ORIGIN })
    );
    assertResponse(res);
    expect(res.status).toBe(200);
  });

  it('500s when the session secret is not configured', async () => {
    delete process.env.WEB_CALL_SESSION_TOKEN_SECRET;
    const res = await POST(postRequest({ sessionToken: await sessionToken() }, { origin: ORIGIN }));
    assertResponse(res);
    expect(res.status).toBe(500);
    expect(await res.json()).not.toHaveProperty('participantToken');
  });

  it('writes no room metadata without a session token', async () => {
    const res = await POST(postRequest({ agentId: 'agent-1' }, { origin: ORIGIN }));
    assertResponse(res);
    const data = await res.json();
    expect(data.roomName).toMatch(/^agent-agent-1-\d+-[0-9a-f]{8}$/);
    expect(roomConfigOf(data.participantToken)?.metadata ?? '').toBe('');
  });

  it('gives two calls made in the same millisecond different rooms', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      const rooms = await Promise.all(
        [1, 2].map(async () => {
          const res = await POST(postRequest({ agentId: 'agent-1' }, { origin: ORIGIN }));
          assertResponse(res);
          return (await res.json()).roomName as string;
        })
      );
      expect(rooms[0]).toMatch(/^agent-agent-1-1800000000000-[0-9a-f]{8}$/);
      expect(rooms[1]).not.toBe(rooms[0]);
    } finally {
      now.mockRestore();
    }
  });
});
