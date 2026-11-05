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

/**
 * Carries a staff role (minted into the token by Connect, lib/handoff/livekit-grant.ts).
 * Any kind other than the agent or the SIP leg counts, so an unexpected kind is restricted,
 * not trusted. This alone decides who is RESTRICTED: fail closed.
 */
function hasStaffRole(participant: RemoteLike): boolean {
  return (
    participant.kind !== ParticipantKind.AGENT &&
    participant.kind !== ParticipantKind.SIP &&
    (VIEWER_ROLES as readonly string[]).includes(participant.attributes?.[ATTR_ROLE] ?? '')
  );
}

/** Connect mints staff identities as `rep-<8hex>` / `obs-<8hex>`; the worker requires the same. */
const STAFF_IDENTITY_PREFIX: Record<ViewerRole, string> = { rep: 'rep-', observer: 'obs-' };

/**
 * A human staff member: the role AND the matching identity prefix, the worker's rule. This
 * decides who is TRUSTED as staff (consent prompt, team strip), so it must not be fakeable.
 */
export function isStaffParticipant(participant: RemoteLike): boolean {
  return (
    hasStaffRole(participant) &&
    participant.identity.startsWith(
      STAFF_IDENTITY_PREFIX[participant.attributes?.[ATTR_ROLE] as ViewerRole]
    )
  );
}

const SCREEN_SOURCES: readonly Track.Source[] = [
  Track.Source.ScreenShare,
  Track.Source.ScreenShareAudio,
];

/**
 * Spec §6 as ruled (R19, R22), pure. While a screen track is live the list is ALWAYS
 * restricted, staff present or not, so someone who joins mid-share is never let in by
 * default before the widget hears they joined. With no screen it is restricted whenever
 * staff are present (they get the microphone, not the camera); with neither, allow all.
 */
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
  if (!screenSid && !remotes.some(hasStaffRole)) {
    return { allParticipantsAllowed: true, trackPermissions: [] };
  }
  const sidsOf = (sources: readonly Track.Source[]) =>
    localTracks
      .filter((track) => track.trackSid && sources.includes(track.source))
      .map((track) => track.trackSid);
  // Staff hear the caller; they never get the camera, and the screen only once allowed.
  const voiceOnly = sidsOf([Track.Source.Microphone]);
  const voiceAndScreen = sidsOf([Track.Source.Microphone, ...SCREEN_SOURCES]);
  return {
    allParticipantsAllowed: false,
    trackPermissions: remotes.map((remote) =>
      !hasStaffRole(remote)
        ? { participantIdentity: remote.identity, allowAll: true }
        : {
            participantIdentity: remote.identity,
            allowedTrackSids: grantedIdentities.has(remote.identity) ? voiceAndScreen : voiceOnly,
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
  /** Everyone waiting on this answer: a repeat request for the same person joins it. */
  waiters: ((outcome: ViewerConsentOutcome) => void)[];
  /** When it reached the head of the queue; answers in the first moment are ignored. */
  shownAt?: number;
  /** Started when the prompt reaches the head of the queue, not when it was asked. */
  timer?: ReturnType<typeof setTimeout>;
};

/** A double tap's second click must not land on the next prompt's button in the same place. */
export const VIEWER_CONSENT_CLICK_GUARD_MS = 500;

/**
 * The head prompt, its countdown started the first time it is shown: always the full 30 s,
 * however long it waited in the queue (the caller is promised 30 s to answer).
 */
function showHead(
  queue: PendingViewer[],
  onTimeout: (entry: PendingViewer, outcome: ViewerConsentOutcome) => void
): ViewerConsentPrompt | null {
  const head = queue[0];
  if (head && !head.timer) {
    const now = Date.now();
    const ms = VIEWER_CONSENT_TIMEOUT_S * 1000;
    head.shownAt = now;
    head.prompt = { ...head.prompt, expiresAt: now + ms };
    head.timer = setTimeout(() => onTimeout(head, 'timeout'), ms);
  }
  return head?.prompt ?? null;
}

export interface ScreenViewerPermissions {
  /** The request at the head of the queue, or null. */
  viewerConsentRequest: ViewerConsentPrompt | null;
  /** Answers the head prompt only if it is still this person's (the overlay passes it). */
  allowViewer: (identity: string) => void;
  denyViewer: (identity: string) => void;
  /**
   * Call immediately BEFORE asking the SDK to publish a screen: restricts staff to the
   * microphone so the new screen sid is in no staff member's list while it negotiates.
   * Throws if the SDK refuses synchronously; the share must then not start.
   */
  restrictBeforeShare: () => void;
  /**
   * Pair of restrictBeforeShare, called once the picker has resolved either way (in a
   * finally). Lifts that start's restriction and recomputes from the room as it is now.
   */
  shareStartEnded: () => void;
  /** The `takeover.requestViewerConsent` RPC handler; registered by the session hook. */
  handleViewerConsent: (data: RpcInvocationData) => Promise<string>;
}

export interface ScreenViewerPermissionsOptions {
  /** The SDK refused the restriction synchronously while a screen is live: stop the share. */
  onRestrictionRefused?: () => void;
}

export function useScreenViewerPermissions(
  options: ScreenViewerPermissionsOptions = {}
): ScreenViewerPermissions {
  const room = useRoomContext();
  const onRestrictionRefusedRef = useRef(options.onRestrictionRefused);
  onRestrictionRefusedRef.current = options.onRestrictionRefused;
  const [viewerConsentRequest, setViewerConsentRequest] = useState<ViewerConsentPrompt | null>(
    null
  );
  /**
   * Grants belong to one screen track (a new share starts with none) and to one session of
   * the viewer: identity -> participant sid when they said yes.
   */
  const grantsRef = useRef<{
    screenSid: string | null;
    identities: Map<string, string | undefined>;
  }>({
    screenSid: null,
    identities: new Map(),
  });
  const queueRef = useRef<PendingViewer[]>([]);

  const screenSidNow = useCallback(
    () => room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.trackSid ?? null,
    [room]
  );

  const finish = useCallback(function finish(entry: PendingViewer, outcome: ViewerConsentOutcome) {
    const index = queueRef.current.indexOf(entry);
    if (index < 0) {
      return;
    }
    queueRef.current.splice(index, 1);
    clearTimeout(entry.timer);
    entry.waiters.forEach((resolve) => resolve(outcome));
    setViewerConsentRequest(showHead(queueRef.current, finish));
  }, []);

  /**
   * Shares being started (picker open). While any is, the list stays restricted as if the
   * screen were already published: a join or mic publish meanwhile must not reopen it.
   * A count, not a flag, so one start finishing cannot lift another's restriction.
   */
  const startingRef = useRef(0);

  const currentPermissions = useCallback(
    (screenSid: string | null) =>
      computePermissions({
        remotes: Array.from(room.remoteParticipants.values()),
        localTracks: Array.from(room.localParticipant.trackPublications.values()),
        grantedIdentities: new Set(grantsRef.current.identities.keys()),
        // Not a real sid: no screen yet, but the list must already be restricted.
        screenSid: screenSid ?? (startingRef.current > 0 ? 'pre-publish' : null),
      }),
    [room]
  );

  const apply = useCallback(() => {
    const screenSid = screenSidNow();
    if (grantsRef.current.screenSid !== screenSid) {
      grantsRef.current = { screenSid, identities: new Map() };
      // A question about a share that has ended has only one true answer.
      queueRef.current
        .filter((entry) => entry.screenSid !== screenSid)
        .forEach((entry) => finish(entry, 'no_share'));
    }
    // A quick rejoin can reach the SDK as an update to the old participant, with no disconnect
    // event: only the changed sid shows it. A new session is asked again.
    grantsRef.current.identities.forEach((sid, identity) => {
      if (room.remoteParticipants.get(identity)?.sid !== sid) {
        grantsRef.current.identities.delete(identity);
      }
    });
    const { allParticipantsAllowed, trackPermissions } = currentPermissions(screenSid);
    try {
      room.localParticipant.setTrackSubscriptionPermissions(
        allParticipantsAllowed,
        trackPermissions
      );
    } catch (err) {
      // Only a SYNCHRONOUS error lands here: the SDK stores the list and sends it
      // fire-and-forget, and re-sends it itself after a reconnect. A screen whose
      // restriction could not even be stored is not left live.
      console.error('[screenshare] could not update track subscription permissions', err);
      if (screenSid) {
        onRestrictionRefusedRef.current?.();
      }
    }
  }, [currentPermissions, finish, room, screenSidNow]);

  useEffect(() => {
    if (!room) {
      return;
    }
    apply();
    // Leaving ends a grant: someone who rejoins mid-share is asked again. It also ends any
    // question about them: the prompt closes, and the agent gets the same 'declined' as for
    // anyone not in the room. finish() then shows the next prompt with its full 30 s.
    const onDisconnected = (participant: { identity: string }) => {
      grantsRef.current.identities.delete(participant.identity);
      queueRef.current
        .filter((entry) => entry.prompt.identity === participant.identity)
        .forEach((entry) => finish(entry, 'declined'));
      apply();
    };
    room.on(RoomEvent.ParticipantDisconnected, onDisconnected);
    const events = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantAttributesChanged,
      // The only events a rejoin without a disconnect is sure to raise (see apply).
      RoomEvent.ParticipantActive,
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished,
    ] as const;
    events.forEach((event) => room.on(event, apply));
    return () => {
      room.off(RoomEvent.ParticipantDisconnected, onDisconnected);
      events.forEach((event) => room.off(event, apply));
    };
  }, [room, apply, finish]);

  // The panel closing leaves no share to see; nobody is left waiting on a dead prompt.
  useEffect(
    () => () => {
      [...queueRef.current].forEach((entry) => finish(entry, 'no_share'));
    },
    [finish]
  );

  const answer = useCallback(
    (allowed: boolean, identity: string) => {
      const entry = queueRef.current[0];
      // A click meant for a prompt that has gone, or one landing just as the next appears.
      if (
        !entry ||
        entry.prompt.identity !== identity ||
        Date.now() - (entry.shownAt ?? 0) < VIEWER_CONSENT_CLICK_GUARD_MS
      ) {
        return;
      }
      if (allowed && grantsRef.current.screenSid === entry.screenSid) {
        grantsRef.current.identities.set(
          entry.prompt.identity,
          room.remoteParticipants.get(entry.prompt.identity)?.sid
        );
      }
      finish(entry, allowed ? 'granted' : 'declined');
      if (allowed) {
        apply();
      }
    },
    [apply, finish, room]
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

      const { identity, name } = payload.viewer;
      // The role the caller sees is the one Connect minted, like the name.
      const role = viewer.attributes?.[ATTR_ROLE] as ViewerRole;
      const already = queueRef.current.find(
        (entry) => entry.prompt.identity === identity && entry.screenSid === screenSid
      );
      if (already) {
        return new Promise<string>((resolve) => {
          already.waiters.push((outcome) => resolve(respond(outcome)));
        });
      }
      // The name Connect minted into the person's token is the one the caller sees.
      const shownName = viewer.attributes?.[ATTR_DISPLAY_NAME]?.trim() || name.trim();
      return new Promise<string>((resolve) => {
        const entry: PendingViewer = {
          prompt: {
            identity,
            name: shownName,
            role,
            timeoutSeconds: VIEWER_CONSENT_TIMEOUT_S,
            expiresAt: 0, // set by showHead
          },
          screenSid,
          waiters: [(outcome) => resolve(respond(outcome))],
        };
        queueRef.current.push(entry);
        setViewerConsentRequest(showHead(queueRef.current, finish));
      });
    },
    [apply, finish, room, screenSidNow]
  );

  const restrictBeforeShare = useCallback(() => {
    // Counted first, so the caller's matching shareStartEnded() always balances it.
    startingRef.current += 1;
    // Grants belong to a screen sid; with no screen yet, the set apply() keyed is empty.
    const { allParticipantsAllowed, trackPermissions } = currentPermissions(screenSidNow());
    room.localParticipant.setTrackSubscriptionPermissions(allParticipantsAllowed, trackPermissions);
  }, [currentPermissions, room, screenSidNow]);

  const shareStartEnded = useCallback(() => {
    startingRef.current = Math.max(0, startingRef.current - 1);
    apply();
  }, [apply]);

  return {
    viewerConsentRequest,
    restrictBeforeShare,
    shareStartEnded,
    allowViewer: useCallback((identity: string) => answer(true, identity), [answer]),
    denyViewer: useCallback((identity: string) => answer(false, identity), [answer]),
    handleViewerConsent,
  };
}
