'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type LocalTrackPublication,
  RoomEvent,
  RpcError,
  type RpcInvocationData,
  Track,
} from 'livekit-client';
import { useRoomContext } from '@livekit/components-react';
import { canCaptureDisplay } from '@/lib/screenshare-capability';
import {
  ATTR_CAPABLE,
  type ConsentResult,
  RPC_REQUEST_CONSENT,
  RPC_STOP,
  type RequestConsentPayload,
  type RequestConsentResponse,
  SCREENSHARE_PROTOCOL_VERSION,
  type ShareSurface,
  type StopReason,
  type StopResponse,
  isCurrentVersion,
} from '@/lib/screenshare-protocol';

/**
 * TLZ-561. Every piece of screenshare state the widget owns: the capability it
 * advertises, the consent prompt, and the screen track itself.
 *
 * Two rules this hook exists to enforce, and they are the same rule twice:
 *  - consent is answered only AFTER the track is published, so a picker the caller
 *    dismissed never looks like a live share the agent then waits on; and
 *  - whatever answers the request first owns the outcome, so a share that started after
 *    the agent was told "no share" is torn down rather than left publishing. A live
 *    track the agent believes was cancelled is the same defect wearing the other face.
 */

/** Preference order, least invasive first. Also the canonical surface list. */
const SURFACE_PREFERENCE: ShareSurface[] = ['browser', 'window', 'monitor'];

export const DEFAULT_ALLOWED_SURFACES: ShareSurface[] = SURFACE_PREFERENCE;

/** Used when the agent's request does not carry its own `timeout_seconds`. */
export const DEFAULT_CONSENT_TIMEOUT_SECONDS = 30;
/** `timeout_seconds` comes from the peer, so it is bounded rather than trusted. */
export const MIN_CONSENT_TIMEOUT_SECONDS = 5;
export const MAX_CONSENT_TIMEOUT_SECONDS = 120;
/** Headroom for the answer to travel back inside the caller's `responseTimeout`. */
const RESPONSE_TRAVEL_SECONDS = 1;

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
  /**
   * From the token route (`capabilities.screenshare`), which resolved org policy and
   * minted the grant to match. Defaults to false: the widget offers nothing until it has
   * been told the organization has the feature.
   */
  enabled?: boolean;
  /** From the token route (`capabilities.allowedSurfaces`), which resolved org policy. */
  allowedSurfaces?: ShareSurface[];
  /**
   * Called once per share that ends, with why it ended. The browser's own "Stop sharing"
   * bar is invisible outside this hook, and `isSharing` alone cannot tell a caller stop
   * from a browser stop from an agent stop -- which is exactly what `StopReason` exists
   * to distinguish, and what a `screenshare.notify` needs in order to be true.
   */
  onStopped?: (reason: StopReason) => void;
}

export interface ScreenshareSession {
  isSharing: boolean;
  consentRequest: ConsentRequest | null;
  acceptConsent: () => Promise<void>;
  declineConsent: () => void;
  startShare: () => Promise<RequestConsentResponse>;
  /** Resolves true only if the track really went down. */
  stopShare: (reason?: StopReason) => Promise<boolean>;
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

/**
 * How long the prompt may stand. Bounded at both ends because `timeout_seconds` arrives
 * from the peer, and capped again by the caller's own `responseTimeout` -- LiveKit's
 * default is 10s, and a prompt that outlives the window the agent is listening on
 * produces an answer nobody receives while the caller believes they are still deciding.
 */
export function consentWindowSeconds(
  requestedSeconds: unknown,
  responseTimeoutMs: unknown
): number {
  const requested = Number(requestedSeconds);
  const asked =
    Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_CONSENT_TIMEOUT_SECONDS;
  let seconds = Math.min(Math.max(asked, MIN_CONSENT_TIMEOUT_SECONDS), MAX_CONSENT_TIMEOUT_SECONDS);

  const window = Number(responseTimeoutMs);
  if (Number.isFinite(window) && window > 0) {
    const usable = Math.floor(window / 1000) - RESPONSE_TRAVEL_SECONDS;
    if (usable > 0) {
      seconds = Math.min(seconds, usable);
    }
  }
  return seconds;
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
  const enabledRef = useRef<boolean>(options.enabled ?? false);
  const allowedSurfacesRef = useRef<ShareSurface[] | undefined>(options.allowedSurfaces);
  const promptSurfacesRef = useRef<ShareSurface[]>(DEFAULT_ALLOWED_SURFACES);
  const onStoppedRef = useRef<UseScreenshareSessionOptions['onStopped']>(options.onStopped);
  /** Set while this hook is the one taking the track down, so the reason is not guessed. */
  const stopReasonRef = useRef<StopReason | null>(null);
  /** How the outstanding request was answered, when something other than the caller answered it. */
  const settledResultRef = useRef<ConsentResult | null>(null);

  useEffect(() => {
    enabledRef.current = options.enabled ?? false;
  }, [options.enabled]);

  useEffect(() => {
    allowedSurfacesRef.current = options.allowedSurfaces;
  }, [options.allowedSurfaces]);

  useEffect(() => {
    onStoppedRef.current = options.onStopped;
  }, [options.onStopped]);

  /** Resolve the outstanding RPC exactly once and take the overlay down. */
  const settle = useCallback((response: RequestConsentResponse) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    settledResultRef.current = response.result;
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

  const stopShare = useCallback(
    async (reason: StopReason = 'caller_stop'): Promise<boolean> => {
      stopReasonRef.current = reason;
      try {
        await room.localParticipant.setScreenShareEnabled(false);
        // The unpublish event reports the reason; if none was emitted there was no track
        // to take down, and there is nothing to report either.
        setIsSharing(false);
        return true;
      } catch (err) {
        // A stop that did not happen is not reported as one: the track may still be
        // live, and `isSharing` has to keep saying so. Nothing here may end or degrade
        // the audio session, so the failure is logged rather than thrown.
        stopReasonRef.current = null;
        console.warn('[screenshare] could not stop the screen track', err);
        return false;
      }
    },
    [room]
  );

  /** Caller-initiated share, with no agent request outstanding. */
  const startShare = useCallback(async (): Promise<RequestConsentResponse> => {
    if (!enabledRef.current) {
      return { v: SCREENSHARE_PROTOCOL_VERSION, result: 'failed', reason: 'not_permitted' };
    }
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
    if (!pending) {
      return;
    }
    // Stop the countdown the moment the caller answers. A timeout firing behind an open
    // picker would answer the agent twice, and the second answer would be a lie.
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    setConsentRequest((request) => (request ? { ...request, capturing: true } : request));

    const response = await accept(promptSurfacesRef.current);

    // Whoever answered first owns the outcome. The agent's `screenshare.stop`, and the
    // panel closing, can both land while the picker is open -- and by then the agent has
    // been told there is no share. So there must not be one: a track that arrives after
    // that answer is taken straight back down rather than left publishing a screen the
    // agent believes was never shared.
    if (pendingRef.current !== pending) {
      if (response.result === 'granted') {
        const stopped = await stopShare(
          settledResultRef.current === 'declined' ? 'caller_stop' : 'agent_end'
        );
        if (!stopped) {
          console.error(
            '[screenshare] a screen track was published after the request was already answered, and could not be stopped'
          );
        }
      }
      setConsentRequest(null);
      return;
    }

    setIsSharing(response.result === 'granted');
    settle(response);
  }, [accept, settle, stopShare]);

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

      // The token is the enforcement point, but a caller whose organization does not have
      // the feature must never see the prompt -- let alone the browser's own picker --
      // only for the publish to be refused afterwards.
      if (!enabledRef.current) {
        return respond({
          v: SCREENSHARE_PROTOCOL_VERSION,
          result: 'failed',
          reason: 'not_permitted',
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
      const timeoutSeconds = consentWindowSeconds(payload.timeout_seconds, data?.responseTimeout);
      if (Number(payload.timeout_seconds) > timeoutSeconds) {
        console.warn(
          `[screenshare] consent prompt shortened to ${timeoutSeconds}s; the agent asked for ${payload.timeout_seconds}s but is listening for ${data?.responseTimeout}ms`
        );
      }
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
  const handleStop = useCallback(
    async (data: RpcInvocationData): Promise<string> => {
      const versionOk = isCurrentVersion(parsePayload(data?.payload));

      // A prompt still on screen means no share ever started. Close it and tell the agent
      // the request ended. `cancelled` is the caller's own dismissal of the picker, so an
      // agent-side withdrawal is `failed` with the reason that says who ended it --
      // attributing it to the caller would put a plausible falsehood in the audit row.
      if (pendingRef.current) {
        settle({ v: SCREENSHARE_PROTOCOL_VERSION, result: 'failed', reason: 'agent_end' });
      }

      // Deliberately asymmetric with requestConsent: refusing to START on a version we do
      // not understand is safe, refusing to STOP is not. A privacy control fails toward
      // stopping, so the track goes down first and the mismatch is reported after.
      const stopped = await stopShare('agent_end');

      if (!versionOk) {
        throw new RpcError(
          RpcError.ErrorCode.UNSUPPORTED_VERSION,
          'screenshare.stop: protocol_version_mismatch'
        );
      }
      if (!stopped) {
        // Never answer `stopped: true` for a stop that did not happen.
        throw new RpcError(
          RpcError.ErrorCode.APPLICATION_ERROR,
          'screenshare.stop: the screen track could not be stopped'
        );
      }

      const response: StopResponse = { v: SCREENSHARE_PROTOCOL_VERSION, stopped: true };
      return JSON.stringify(response);
    },
    [settle, stopShare]
  );

  // A4: advertise the capability as soon as there is a session to advertise it on, so the
  // agent knows before it offers rather than after the caller agrees. This says what the
  // BROWSER can do; whether the organization may is the token's business, not this flag's.
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

  // The browser's own "Stop sharing" bar ends the share without going through this hook.
  // Track publication state is the source of truth, and this is the only place a stop is
  // reported, so one ended share produces exactly one `onStopped`.
  useEffect(() => {
    if (!room) {
      return;
    }
    const onUnpublished = (publication: LocalTrackPublication) => {
      if (publication.source !== Track.Source.ScreenShare) {
        return;
      }
      setIsSharing(false);
      const reason = stopReasonRef.current ?? 'browser_stop';
      stopReasonRef.current = null;
      onStoppedRef.current?.(reason);
    };
    // The session ending is not a stop anyone can act on: there is no room left to notify.
    const onDisconnected = () => setIsSharing(false);

    room.on(RoomEvent.LocalTrackUnpublished, onUnpublished);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.LocalTrackUnpublished, onUnpublished);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room]);

  // The panel can close with a request still outstanding; the agent is told rather than
  // left waiting for a promise nobody will ever settle. A capture still in flight is
  // caught by the ownership check in acceptConsent, which runs even after unmount.
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
