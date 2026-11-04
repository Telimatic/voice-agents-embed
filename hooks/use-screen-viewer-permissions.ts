'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ParticipantKind,
  RoomEvent,
  RpcError,
  type RpcInvocationData,
  Track,
} from 'livekit-client';
import { useRoomContext } from '@livekit/components-react';
import { type AgentParticipantLike, isAgentParticipant } from '@/hooks/use-screenshare-peer';
import {
  ATTR_DISPLAY_NAME,
  ATTR_ROLE,
  SCREENSHARE_PROTOCOL_VERSION,
  VIEWER_CONSENT_TIMEOUT_S,
  VIEWER_ROLES,
  type ViewerConsentOutcome,
  type ViewerConsentResponse,
  type ViewerRole,
  isViewerConsentRequest,
} from '@/lib/screenshare-protocol';

/**
 * TLZ-561 (D6, D12). The widget is where a caller's screen is kept from people: a rep or
 * observer in the room receives the caller's voice, and the screen only once the caller
 * has allowed that person for this share. Everyone else (the AI agent, `human-agent-sip`)
 * keeps receiving every track. Recorder/egress participants are exempt server-side.
 */

export interface RemoteLike {
  identity: string;
  kind?: ParticipantKind;
  attributes?: Record<string, string>;
}

export interface LocalTrackLike {
  trackSid: string;
  source: Track.Source;
}

export interface TrackPermission {
  participantIdentity: string;
  allowAll?: boolean;
  allowedTrackSids?: string[];
}

/** A human staff member joined through the dashboard (role minted into their token). */
export function isStaffParticipant(participant: RemoteLike): boolean {
  return (
    participant.kind === ParticipantKind.STANDARD &&
    (VIEWER_ROLES as readonly string[]).includes(participant.attributes?.[ATTR_ROLE] ?? '')
  );
}

const SCREEN_SOURCES: readonly Track.Source[] = [
  Track.Source.ScreenShare,
  Track.Source.ScreenShareAudio,
];

/** Spec §6, pure. */
export function computePermissions({
  remotes,
  localTracks,
  grantedIdentities,
  screenSid,
}: {
  remotes: RemoteLike[];
  localTracks: LocalTrackLike[];
  grantedIdentities: ReadonlySet<string>;
  screenSid: string | null;
}): { allParticipantsAllowed: boolean; trackPermissions: TrackPermission[] } {
  if (!remotes.some(isStaffParticipant)) {
    return { allParticipantsAllowed: true, trackPermissions: [] };
  }
  const published = localTracks.filter((track) => track.trackSid);
  const voiceOnly = published
    .filter((track) => !SCREEN_SOURCES.includes(track.source))
    .map((track) => track.trackSid);
  const everything = published.map((track) => track.trackSid);
  return {
    allParticipantsAllowed: false,
    trackPermissions: remotes.map((remote) =>
      !isStaffParticipant(remote)
        ? { participantIdentity: remote.identity, allowAll: true }
        : {
            participantIdentity: remote.identity,
            allowedTrackSids:
              screenSid && grantedIdentities.has(remote.identity) ? everything : voiceOnly,
          }
    ),
  };
}

export interface ViewerConsentPrompt {
  identity: string;
  name: string;
  role: ViewerRole;
  timeoutSeconds: number;
  expiresAt: number;
}

type PendingViewer = {
  prompt: ViewerConsentPrompt;
  /** The share this request is about; a different (or no) share makes it moot. */
  screenSid: string;
  resolve: (outcome: ViewerConsentOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

export interface ScreenViewerPermissions {
  /** The request at the head of the queue, or null. */
  viewerConsentRequest: ViewerConsentPrompt | null;
  allowViewer: () => void;
  denyViewer: () => void;
  /** The `takeover.requestViewerConsent` RPC handler; registered by the session hook. */
  handleViewerConsent: (data: RpcInvocationData) => Promise<string>;
}

export function useScreenViewerPermissions(): ScreenViewerPermissions {
  const room = useRoomContext();
  const [viewerConsentRequest, setViewerConsentRequest] = useState<ViewerConsentPrompt | null>(
    null
  );
  /** Grants belong to one screen track: a new share (new sid) starts with none. */
  const grantsRef = useRef<{ screenSid: string | null; identities: Set<string> }>({
    screenSid: null,
    identities: new Set(),
  });
  const queueRef = useRef<PendingViewer[]>([]);

  const screenSidNow = useCallback(
    () => room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.trackSid ?? null,
    [room]
  );

  const finish = useCallback((entry: PendingViewer, outcome: ViewerConsentOutcome) => {
    const index = queueRef.current.indexOf(entry);
    if (index < 0) {
      return;
    }
    queueRef.current.splice(index, 1);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
    setViewerConsentRequest(queueRef.current[0]?.prompt ?? null);
  }, []);

  const apply = useCallback(() => {
    const screenSid = screenSidNow();
    if (grantsRef.current.screenSid !== screenSid) {
      grantsRef.current = { screenSid, identities: new Set() };
      // A question about a share that has ended has only one true answer.
      queueRef.current
        .filter((entry) => entry.screenSid !== screenSid)
        .forEach((entry) => finish(entry, 'no_share'));
    }
    const { allParticipantsAllowed, trackPermissions } = computePermissions({
      remotes: Array.from(room.remoteParticipants.values()),
      localTracks: Array.from(room.localParticipant.trackPublications.values()),
      grantedIdentities: grantsRef.current.identities,
      screenSid,
    });
    try {
      room.localParticipant.setTrackSubscriptionPermissions(
        allParticipantsAllowed,
        trackPermissions
      );
    } catch (err) {
      console.error('[screenshare] could not update track subscription permissions', err);
    }
  }, [finish, room, screenSidNow]);

  useEffect(() => {
    if (!room) {
      return;
    }
    apply();
    const events = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.ParticipantAttributesChanged,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
    ] as const;
    events.forEach((event) => room.on(event, apply));
    return () => {
      events.forEach((event) => room.off(event, apply));
    };
  }, [room, apply]);

  // The panel closing leaves no share to see; nobody is left waiting on a dead prompt.
  useEffect(
    () => () => {
      [...queueRef.current].forEach((entry) => finish(entry, 'no_share'));
    },
    [finish]
  );

  const answer = useCallback(
    (allowed: boolean) => {
      const entry = queueRef.current[0];
      if (!entry) {
        return;
      }
      if (allowed && grantsRef.current.screenSid === entry.screenSid) {
        grantsRef.current.identities.add(entry.prompt.identity);
      }
      finish(entry, allowed ? 'granted' : 'declined');
      if (allowed) {
        apply();
      }
    },
    [apply, finish]
  );

  const handleViewerConsent = useCallback(
    async (data: RpcInvocationData): Promise<string> => {
      const respond = (outcome: ViewerConsentOutcome) =>
        JSON.stringify({
          v: SCREENSHARE_PROTOCOL_VERSION,
          outcome,
        } satisfies ViewerConsentResponse);

      // Only the AI agent may ask. A rep or observer can send RPCs too, and must not be
      // able to put "let me see your screen" in front of the caller on their own behalf.
      const caller = room.remoteParticipants.get(data?.callerIdentity ?? '');
      if (!isAgentParticipant(caller as AgentParticipantLike | undefined)) {
        return respond('declined');
      }

      let payload: unknown = null;
      try {
        payload = JSON.parse(data?.payload ?? '');
      } catch {
        // falls through to the guard
      }
      if (!isViewerConsentRequest(payload)) {
        throw new RpcError(
          RpcError.ErrorCode.APPLICATION_ERROR,
          'takeover.requestViewerConsent: bad_payload'
        );
      }
      // A grant only ever goes to a staff member who is in the room right now.
      const viewer = room.remoteParticipants.get(payload.viewer.identity);
      if (!viewer || !isStaffParticipant(viewer)) {
        return respond('declined');
      }

      const screenSid = screenSidNow();
      if (!screenSid) {
        return respond('no_share');
      }
      // Make sure grants are keyed to this share before one can be added to it.
      apply();

      const { identity, name, role } = payload.viewer;
      // The name the dashboard minted into the person's token is the one the caller sees.
      const shownName = viewer.attributes?.[ATTR_DISPLAY_NAME]?.trim() || name.trim();
      return new Promise<string>((resolve) => {
        const entry: PendingViewer = {
          prompt: {
            identity,
            name: shownName,
            role,
            timeoutSeconds: VIEWER_CONSENT_TIMEOUT_S,
            expiresAt: Date.now() + VIEWER_CONSENT_TIMEOUT_S * 1000,
          },
          screenSid,
          resolve: (outcome) => resolve(respond(outcome)),
          timer: setTimeout(() => finish(entry, 'timeout'), VIEWER_CONSENT_TIMEOUT_S * 1000),
        };
        queueRef.current.push(entry);
        setViewerConsentRequest(queueRef.current[0].prompt);
      });
    },
    [apply, finish, room, screenSidNow]
  );

  return {
    viewerConsentRequest,
    allowViewer: useCallback(() => answer(true), [answer]),
    denyViewer: useCallback(() => answer(false), [answer]),
    handleViewerConsent,
  };
}
