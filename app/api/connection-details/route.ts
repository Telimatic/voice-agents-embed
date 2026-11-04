import { NextResponse } from 'next/server';
import { AccessToken, type AccessTokenOptions, type VideoGrant } from 'livekit-server-sdk';
import { RoomConfiguration, TrackSource } from '@livekit/protocol';
import { ATTR_CLIENT_IP, clientIpFromHeaders } from '@/lib/client-ip';
import { ATTR_CAPABLE } from '@/lib/screenshare-protocol';
import {
  ROOM_METADATA_SESSION_KEY,
  WebCallSessionTokenError,
  verifyWebCallSessionToken,
} from '@/lib/web-call-session-token';

// NOTE: you are expected to define the following environment variables in `.env.local`:
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;

// don't cache the results
export const revalidate = 0;

export type ConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Sandbox-Id',
};

function refuse(status: number, body: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...CORS_HEADERS },
  });
}

export async function POST(req: Request) {
  try {
    if (LIVEKIT_URL === undefined) {
      throw new Error('LIVEKIT_URL is not defined');
    }
    if (API_KEY === undefined) {
      throw new Error('LIVEKIT_API_KEY is not defined');
    }
    if (API_SECRET === undefined) {
      throw new Error('LIVEKIT_API_SECRET is not defined');
    }

    // Parse agent configuration from request body
    const body = await req.json();
    let agentId: string = body?.agentId;
    const agentName: string = body?.room_config?.agents?.[0]?.agent_name;

    // TLZ-742: a web call session. The partner's server saved this call's business details in
    // the Dashboard and handed its page a 5-minute token naming the session, the agent and
    // the website the call may start from. The browser's Origin header must be that website.
    // Only the session id goes on: into the room metadata, which only the token's minter can
    // write, where the worker reads it at job start and fetches the details server-side.
    let webCallSessionId: string | null = null;
    if (body?.sessionToken !== undefined && body?.sessionToken !== null) {
      const secret = process.env.WEB_CALL_SESSION_TOKEN_SECRET;
      if (!secret) {
        console.error('WEB_CALL_SESSION_TOKEN_SECRET is not defined');
        return refuse(500, { error: 'web_call_sessions_not_configured' });
      }
      try {
        const verified = await verifyWebCallSessionToken(
          body.sessionToken,
          req.headers.get('origin'),
          secret
        );
        if (agentId && agentId.toLowerCase() !== verified.agentId.toLowerCase()) {
          return refuse(400, { error: 'agent_mismatch' });
        }
        agentId = verified.agentId;
        webCallSessionId = verified.sessionId;
      } catch (error) {
        if (error instanceof WebCallSessionTokenError) {
          return refuse(401, { error: 'invalid_session_token', reason: error.code });
        }
        throw error;
      }
    }

    // Generate participant token
    const participantName = body?.participantName || 'Guest';
    // A4: does this BROWSER have a usable getDisplayMedia at all (lib/screenshare-capability.ts)?
    // Reported by the client and stamped into the token below rather than written by the
    // participant after joining — see createParticipantToken.
    const capable: boolean = body?.capable === true;
    // TLZ-706: the visitor's public IP, from Cloudflare's own header (lib/client-ip.ts).
    // Stamped into the token like `capable`, so the browser cannot change it after joining.
    const clientIp = clientIpFromHeaders(req.headers);
    const participantIdentity = `embed_user_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;

    // Room name format: agent-{agentId}-{timestamp}
    // This format is required for the agent service to recognize and join the room
    const timestamp = Date.now();
    const roomName = agentId
      ? `agent-${agentId}-${timestamp}`
      : `voice_assistant_room_${timestamp}`;

    const participantToken = await createParticipantToken(
      { identity: participantIdentity, name: participantName },
      roomName,
      capable,
      clientIp,
      agentName,
      webCallSessionId
    );

    // Return connection details
    const data: ConnectionDetails = {
      serverUrl: LIVEKIT_URL,
      roomName,
      participantToken: participantToken,
      participantName,
    };

    const headers = new Headers({
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    });
    return NextResponse.json(data, { headers });
  } catch (error) {
    if (error instanceof Error) {
      console.error(error);
      return new NextResponse(error.message, { status: 500 });
    }
  }
}

// Handle CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, { headers: CORS_HEADERS });
}

function createParticipantToken(
  userInfo: AccessTokenOptions,
  roomName: string,
  capable: boolean,
  clientIp: string | null,
  agentName?: string,
  webCallSessionId?: string | null
): Promise<string> {
  const at = new AccessToken(API_KEY, API_SECRET, {
    ...userInfo,
    ttl: '15m',
    // A4: stamped into the token, NOT written by the participant after joining.
    //
    // This route is public with CORS `*`, so anyone can mint a token and join any agent's
    // room as `embed_user_*`. Granting `canUpdateOwnMetadata` so the widget could call
    // setAttributes() would let that anonymous participant write ANY attribute key:
    // LiveKit's server applies no prefix filtering (pkg/rtc/participant.go SetAttributes
    // stores every key it is given). The worker reads caller identity off participant
    // attributes — the unprefixed `caller` key first, then `sip.*` — with no participant-
    // kind check, and the widget joins before the agent enumerates participants. A
    // tampered page could therefore have set `caller: '+1555...'` and fed known-caller
    // detection, caller-ID pre-auth, TeamMate webhooks and the NetSapiens PIN gate an
    // attacker-controlled number.
    //
    // Minting the attributes we actually need keeps the worker protocol identical (it
    // reads the attribute off the participant regardless of who set it) while leaving the
    // participant with no attribute-write permission at all. Deviates from spec §2.2,
    // which did not consider this vector.
    attributes: {
      [ATTR_CAPABLE]: capable ? 'true' : 'false',
      // TLZ-706: only when an IP was found; the worker then records plain `web`.
      ...(clientIp ? { [ATTR_CLIENT_IP]: clientIp } : {}),
    },
  });
  const grant: VideoGrant = {
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
    // TLZ-561. The grant is FIXED at mint: no organization policy is consulted here, and
    // SCREEN_SHARE is never in a token. The worker, which is the one party that resolves
    // policy for a session, widens the participant's permission at runtime once the
    // resolver has approved it (UpdateParticipant). Until then the server refuses a
    // screen track whatever a tampered client asks for.
    //
    // CAMERA stays: the base grant before TLZ-561 carried no canPublishSources at all,
    // which LiveKit treats as "every source permitted", and camera publishing is gated
    // by the unrelated supportsVideoInput / remote config, not by this feature.
    canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
  };
  at.addGrant(grant);

  // TLZ-742: the session id rides in the room metadata. With no agents listed, LiveKit still
  // makes its default dispatch, so unnamed (automatically dispatched) workers get the job.
  if (agentName || webCallSessionId) {
    at.roomConfig = new RoomConfiguration({
      ...(agentName ? { agents: [{ agentName }] } : {}),
      ...(webCallSessionId
        ? { metadata: JSON.stringify({ [ROOM_METADATA_SESSION_KEY]: webCallSessionId }) }
        : {}),
    });
  }

  return at.toJwt();
}
