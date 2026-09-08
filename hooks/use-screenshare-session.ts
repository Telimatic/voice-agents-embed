'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type LocalTrackPublication,
  RoomEvent,
  type RpcInvocationData,
  Track,
} from 'livekit-client';
import { useRoomContext } from '@livekit/components-react';
import { canCaptureDisplay } from '@/lib/screenshare-capability';
import {
  ATTR_CAPABLE,
  RPC_REQUEST_CONSENT,
  RPC_STOP,
  type RequestConsentPayload,
  type RequestConsentResponse,
  SCREENSHARE_PROTOCOL_VERSION,
  type ShareSurface,
  type StopResponse,
  isCurrentVersion,
} from '@/lib/screenshare-protocol';

/**
 * TLZ-561. Every piece of screenshare state the widget owns: the capability it
 * advertises, the consent prompt, and the screen track itself.
 *
 * The single rule this hook exists to enforce is that consent is answered only AFTER
 * the track is published. Answering `granted` any earlier is what makes a picker the
 * caller dismissed look, to the agent, like a live share it then waits on.
 */

/** Preference order, least invasive first. Also the canonical surface list. */
const SURFACE_PREFERENCE: ShareSurface[] = ['browser', 'window', 'monitor'];

export const DEFAULT_ALLOWED_SURFACES: ShareSurface[] = SURFACE_PREFERENCE;

/** Used when the agent's request does not carry its own `timeout_seconds`. */
export const DEFAULT_CONSENT_TIMEOUT_SECONDS = 30;

export interface ConsentRequest {
  /** The surfaces this caller may choose between: the agent's scope, narrowed by policy. */
  surfaces: ShareSurface[];
  timeoutSeconds: number;
  /** Wall-clock deadline, so the overlay can show the countdown rather than hide it. */
  expiresAt: number;
  /** True once the caller has pressed Share and the browser picker is open. */
  capturing: boolean;
}

export interface UseScreenshareSessionOptions {
  /** From the token route (`capabilities.allowedSurfaces`), which resolved org policy. */
  allowedSurfaces?: ShareSurface[];
}

export interface ScreenshareSession {
  isSharing: boolean;
  consentRequest: ConsentRequest | null;
  acceptConsent: () => Promise<void>;
  declineConsent: () => void;
  startShare: () => Promise<RequestConsentResponse>;
  stopShare: () => Promise<void>;
}

/**
 * The `displaySurface` we ask the browser for. It is a HINT and nothing more: Chrome
 * honours it, other browsers ignore it, and no browser lets a page restrict its own
 * picker. What the caller actually chose is read back with `surfaceOf`.
 */
export function preferredSurface(allowedSurfaces?: ShareSurface[]): ShareSurface {
  const allowList = allowedSurfaces?.length ? allowedSurfaces : DEFAULT_ALLOWED_SURFACES;
  return SURFACE_PREFERENCE.find((surface) => allowList.includes(surface)) ?? 'browser';
}

/**
 * The surface the caller actually picked, read off the published track. This -- not the
 * surface we asked for -- is what the agent is told and what the audit row records.
 */
export function surfaceOf(publication: LocalTrackPublication): ShareSurface | undefined {
  const settings = publication.track?.mediaStreamTrack?.getSettings?.() as
    | (MediaTrackSettings & { displaySurface?: string })
    | undefined;
  const surface = settings?.displaySurface as ShareSurface | undefined;
  return surface && SURFACE_PREFERENCE.includes(surface) ? surface : undefined;
}

/** The agent's requested scope, narrowed by what org policy allows. */
export function negotiateSurfaces(
  requested?: ShareSurface[],
  allowedSurfaces?: ShareSurface[]
): ShareSurface[] {
  const allowList = allowedSurfaces?.length ? allowedSurfaces : DEFAULT_ALLOWED_SURFACES;
  if (!requested?.length) {
    return allowList;
  }
  const narrowed = allowList.filter((surface) => requested.includes(surface));
  // An empty intersection means the agent asked for something policy forbids. Offering
  // the policy list is the honest fallback; the picker is the caller's choice anyway.
  return narrowed.length ? narrowed : allowList;
}

function parsePayload(raw: string | undefined): Partial<RequestConsentPayload> {
  try {
    const parsed = JSON.parse(raw ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

type PendingConsent = {
  resolve: (response: RequestConsentResponse) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

export function useScreenshareSession(
  options: UseScreenshareSessionOptions = {}
): ScreenshareSession {
  const room = useRoomContext();
  // Evaluated once per session: the browser cannot grow the ability mid-call.
  const capable = useMemo(() => canCaptureDisplay(), []);

  const [isSharing, setIsSharing] = useState(false);
  const [consentRequest, setConsentRequest] = useState<ConsentRequest | null>(null);

  const pendingRef = useRef<PendingConsent | null>(null);
  const allowedSurfacesRef = useRef<ShareSurface[] | undefined>(options.allowedSurfaces);
  const promptSurfacesRef = useRef<ShareSurface[]>(DEFAULT_ALLOWED_SURFACES);

  useEffect(() => {
    allowedSurfacesRef.current = options.allowedSurfaces;
  }, [options.allowedSurfaces]);

  /** Resolve the outstanding RPC exactly once and take the overlay down. */
  const settle = useCallback((response: RequestConsentResponse) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setConsentRequest(null);
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    pending?.resolve(response);
  }, []);

  const accept = useCallback(
    async (allowedSurfaces: ShareSurface[]): Promise<RequestConsentResponse> => {
      const localParticipant = room.localParticipant;
      try {
        const pub = await localParticipant.setScreenShareEnabled(true, {
          // Tab audio is never captured: the caller is already on a voice call and
          // publishing their tab's audio would echo it back into the room.
          audio: false,
          video: { displaySurface: preferredSurface(allowedSurfaces) },
          contentHint: 'text',
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          // Screen content is mostly static, so a low frame rate costs the agent nothing
          // and leaves far more headroom for the audio the call actually depends on.
          resolution: { width: 1920, height: 1080, frameRate: 3 },
        });
        if (!pub)
          return { v: SCREENSHARE_PROTOCOL_VERSION, result: 'failed', reason: 'no_publication' };
        return {
          v: SCREENSHARE_PROTOCOL_VERSION,
          result: 'granted',
          surface: surfaceOf(pub),
          track_sid: pub.trackSid,
        };
      } catch (err) {
        const name = (err as Error)?.name;
        // The caller dismissed the picker. That is a decision, not a fault.
        const result = name === 'NotAllowedError' ? 'cancelled' : 'failed';
        return { v: SCREENSHARE_PROTOCOL_VERSION, result, reason: name };
      }
    },
    [room]
  );

  const stopShare = useCallback(async () => {
    try {
      await room.localParticipant.setScreenShareEnabled(false);
    } catch (err) {
      // Nothing here may end or degrade the audio session: a stop that fails leaves the
      // voice call untouched and the widget's own state honest.
      console.warn('[screenshare] could not stop the screen track', err);
    } finally {
      setIsSharing(false);
    }
  }, [room]);

  /** Caller-initiated share, with no agent request outstanding. */
  const startShare = useCallback(async (): Promise<RequestConsentResponse> => {
    if (!capable) {
      return {
        v: SCREENSHARE_PROTOCOL_VERSION,
        result: 'unsupported',
        reason: 'no_display_capture',
      };
    }
    const response = await accept(allowedSurfacesRef.current ?? DEFAULT_ALLOWED_SURFACES);
    setIsSharing(response.result === 'granted');
    return response;
  }, [accept, capable]);

  const acceptConsent = useCallback(async () => {
    const pending = pendingRef.current;
    // Stop the countdown the moment the caller answers. A timeout firing behind an open
    // picker would answer the agent twice, and the second answer would be a lie.
    if (pending?.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    setConsentRequest((request) => (request ? { ...request, capturing: true } : request));

    const response = await accept(promptSurfacesRef.current);
    setIsSharing(response.result === 'granted');

    if (pendingRef.current) {
      settle(response);
    } else {
      setConsentRequest(null);
    }
  }, [accept, settle]);

  const declineConsent = useCallback(() => {
    settle({ v: SCREENSHARE_PROTOCOL_VERSION, result: 'declined' });
  }, [settle]);

  // Agent -> widget: "may I see your screen?"
  const handleRequestConsent = useCallback(
    async (data: RpcInvocationData): Promise<string> => {
      // The SDK requires a string return; every answer goes back through here.
      const respond = (response: RequestConsentResponse) => JSON.stringify(response);
      const payload = parsePayload(data?.payload);

      if (!isCurrentVersion(payload)) {
        // A mismatched peer is refused rather than guessed at.
        return respond({
          v: SCREENSHARE_PROTOCOL_VERSION,
          result: 'failed',
          reason: 'protocol_version_mismatch',
        });
      }

      // No picker is opened on a device that cannot capture: the caller is never asked
      // to agree to something that would only fail afterwards.
      if (!capable) {
        return respond({
          v: SCREENSHARE_PROTOCOL_VERSION,
          result: 'unsupported',
          reason: 'no_display_capture',
        });
      }

      if (pendingRef.current) {
        return respond({
          v: SCREENSHARE_PROTOCOL_VERSION,
          result: 'failed',
          reason: 'already_pending',
        });
      }

      const surfaces = negotiateSurfaces(payload.scope, allowedSurfacesRef.current);
      const requested = Number(payload.timeout_seconds);
      const timeoutSeconds =
        Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_CONSENT_TIMEOUT_SECONDS;
      promptSurfacesRef.current = surfaces;

      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          settle({ v: SCREENSHARE_PROTOCOL_VERSION, result: 'timeout' });
        }, timeoutSeconds * 1000);

        pendingRef.current = {
          resolve: (response) => resolve(respond(response)),
          timer,
        };
        setConsentRequest({
          surfaces,
          timeoutSeconds,
          expiresAt: Date.now() + timeoutSeconds * 1000,
          capturing: false,
        });
      });
    },
    [capable, settle]
  );

  // Agent -> widget: "stop sharing".
  const handleStop = useCallback(async (): Promise<string> => {
    // A prompt still on screen means no share ever started. Close it and tell the agent
    // the request ended, rather than leaving a dead overlay in front of the caller.
    if (pendingRef.current) {
      settle({ v: SCREENSHARE_PROTOCOL_VERSION, result: 'cancelled', reason: 'agent_end' });
    }
    await stopShare();
    const response: StopResponse = { v: SCREENSHARE_PROTOCOL_VERSION, stopped: true };
    return JSON.stringify(response);
  }, [settle, stopShare]);

  // A4: advertise the capability as soon as there is a session to advertise it on, so the
  // agent knows before it offers rather than after the caller agrees.
  useEffect(() => {
    if (!room) {
      return;
    }
    const publishCapability = () => {
      try {
        void Promise.resolve(
          room.localParticipant.setAttributes({ [ATTR_CAPABLE]: String(capable) })
        ).catch((err) => {
          console.warn('[screenshare] could not publish the capability attribute', err);
        });
      } catch (err) {
        console.warn('[screenshare] could not publish the capability attribute', err);
      }
    };

    if (room.state === 'connected') {
      publishCapability();
    }
    room.on(RoomEvent.Connected, publishCapability);
    return () => {
      room.off(RoomEvent.Connected, publishCapability);
    };
  }, [room, capable]);

  useEffect(() => {
    if (!room) {
      return;
    }
    const register = (method: string, handler: (data: RpcInvocationData) => Promise<string>) => {
      // registerRpcMethod throws if the name is already taken (e.g. a re-registration
      // after a hot reload), and a throw here would take the whole widget down.
      try {
        room.unregisterRpcMethod(method);
        room.registerRpcMethod(method, handler);
      } catch (err) {
        console.warn(`[screenshare] could not register ${method}`, err);
      }
    };

    register(RPC_REQUEST_CONSENT, handleRequestConsent);
    register(RPC_STOP, handleStop);

    return () => {
      try {
        room.unregisterRpcMethod(RPC_REQUEST_CONSENT);
        room.unregisterRpcMethod(RPC_STOP);
      } catch (err) {
        console.warn('[screenshare] could not unregister the RPC handlers', err);
      }
    };
  }, [room, handleRequestConsent, handleStop]);

  // The browser's own "Stop sharing" bar, and the end of the session, both end the share
  // without going through this hook. Track publication state is the source of truth.
  useEffect(() => {
    if (!room) {
      return;
    }
    const onUnpublished = (publication: LocalTrackPublication) => {
      if (publication.source === Track.Source.ScreenShare) {
        setIsSharing(false);
      }
    };
    const onDisconnected = () => setIsSharing(false);

    room.on(RoomEvent.LocalTrackUnpublished, onUnpublished);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.LocalTrackUnpublished, onUnpublished);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room]);

  // The panel can close with a request still outstanding; the agent is told rather than
  // left waiting for a promise nobody will ever settle.
  useEffect(
    () => () => {
      if (pendingRef.current) {
        settle({ v: SCREENSHARE_PROTOCOL_VERSION, result: 'failed', reason: 'widget_closed' });
      }
    },
    [settle]
  );

  return { isSharing, consentRequest, acceptConsent, declineConsent, startShare, stopShare };
}

export default useScreenshareSession;
