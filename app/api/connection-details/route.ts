import { NextResponse } from 'next/server';
import { AccessToken, type AccessTokenOptions, type VideoGrant } from 'livekit-server-sdk';
import { RoomConfiguration, TrackSource } from '@livekit/protocol';
import { type WidgetScreenshareConfig, fetchScreenshareConfig } from '@/lib/embed-config-client';
import type { ShareSurface } from '@/lib/screenshare-protocol';

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
  // TLZ-561. The token is the authority on whether this session may publish a screen
  // track; the widget reads this to decide whether to offer the control at all.
  capabilities: {
    screenshare: boolean;
    allowedSurfaces?: ShareSurface[];
  };
};

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
    const agentId: string = body?.agentId;
    const agentName: string = body?.room_config?.agents?.[0]?.agent_name;

    // Generate participant token
    const participantName = body?.participantName || 'Guest';
    const participantIdentity = `embed_user_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;

    // Room name format: agent-{agentId}-{timestamp}
    // This format is required for the agent service to recognize and join the room
    const timestamp = Date.now();
    const roomName = agentId
      ? `agent-${agentId}-${timestamp}`
      : `voice_assistant_room_${timestamp}`;

    // TLZ-561. Resolved before minting so the grant itself, not just the UI, is the
    // enforcement point (spec D-5): a tampered client cannot request a screen track the
    // token never authorized. Every failure path here already resolves to "disabled" —
    // see lib/embed-config-client.ts — so a screenshare outage never blocks the call.
    const screenshare: WidgetScreenshareConfig = agentId
      ? await fetchScreenshareConfig(agentId)
      : { enabled: false, reason: 'no_agent_id' };

    const participantToken = await createParticipantToken(
      { identity: participantIdentity, name: participantName },
      roomName,
      screenshare,
      agentName
    );

    // Return connection details
    const data: ConnectionDetails = {
      serverUrl: LIVEKIT_URL,
      roomName,
      participantToken: participantToken,
      participantName,
      capabilities: {
        screenshare: screenshare.enabled,
        allowedSurfaces: screenshare.allowedSurfaces,
      },
    };

    const headers = new Headers({
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Sandbox-Id',
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
  return new NextResponse(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Sandbox-Id',
    },
  });
}

function createParticipantToken(
  userInfo: AccessTokenOptions,
  roomName: string,
  screenshare: WidgetScreenshareConfig,
  agentName?: string
): Promise<string> {
  const at = new AccessToken(API_KEY, API_SECRET, {
    ...userInfo,
    ttl: '15m',
  });
  const grant: VideoGrant = {
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
    // The widget sets telzino.screenshare.capable so the agent knows, before it offers,
    // whether this browser can capture a display at all (story A4).
    canUpdateOwnMetadata: true,
    // Enforcement at mint (spec D-5). usePublishPermissions already hides the share
    // control when SCREEN_SHARE is absent, so this is both the server-side guarantee and
    // the client-side gate, with no extra UI logic.
    //
    // CAMERA is included in both branches: this feature gates screenshare only. The base
    // grant before TLZ-561 carried no canPublishSources at all, which LiveKit treats as
    // "every source permitted" — omitting CAMERA here would silently take away camera
    // publishing (gated by the unrelated supportsVideoInput/remote config) any time this
    // code runs, which is not this task's job.
    canPublishSources: screenshare.enabled
      ? [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE]
      : [TrackSource.CAMERA, TrackSource.MICROPHONE],
  };
  at.addGrant(grant);

  if (agentName) {
    at.roomConfig = new RoomConfiguration({
      agents: [{ agentName }],
    });
  }

  return at.toJwt();
}
