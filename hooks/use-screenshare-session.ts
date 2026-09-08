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
import {
  type AgentParticipantLike,
  isAgentParticipant,
  useScreenshareAgent,
} from '@/hooks/use-screenshare-peer';
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

/**
 * How long an agent may be gone before its departure is treated as the end of the share.
 *
 * A full reconnect disconnects every remote participant and brings them straight back,
 * and the SDK republishes the local tracks with them. Tearing a caller's screen share
 * down on a network blip is a worse outcome -- and a falser one -- than a share that
 * outlives the agent by a second and a half.
 */
export const AGENT_LEFT_GRACE_MS = 1_500;

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
  /** True only while an agent that can receive a share is in the room (A2). */
  agentReady: boolean;
  /**
   * Whether the share control may be offered at all: the token granted the capability,
   * this browser can capture a display, and there is an agent listening for the share.
   */
  canShare: boolean;
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
export function askedWindowSeconds(requestedSeconds: unknown): number {
  const requested = Number(requestedSeconds);
  // An absent or unusable `timeout_seconds` means the default was asked for, not NaN.
  return Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_CONSENT_TIMEOUT_SECONDS;
}

export function consentWindowSeconds(
  requestedSeconds: unknown,
  responseTimeoutMs: unknown
): number {
  const asked = askedWindowSeconds(requestedSeconds);
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
  const { agentReady } = useScreenshareAgent();

  const [isSharing, setIsSharing] = useState(false);
  const [consentRequest, setConsentRequest] = useState<ConsentRequest | null>(null);

  const pendingRef = useRef<PendingConsent | null>(null);
  const enabledRef = useRef<boolean>(options.enabled ?? false);
  const allowedSurfacesRef = useRef<ShareSurface[] | undefined>(options.allowedSurfaces);
  const promptSurfacesRef = useRef<ShareSurface[]>(DEFAULT_ALLOWED_SURFACES);
  const onStoppedRef = useRef<UseScreenshareSessionOptions['onStopped']>(options.onStopped);
  /** Set while this hook is the one taking the track down, so the reason is not guessed. */
  const stopReasonRef = useRef<StopReason | null>(null);
  /** True while a browser picker is open, so a second accept cannot open a second one. */
  const capturingRef = useRef(false);
  /** How the outstanding request was answered, when something other than the caller answered it. */
  const settledResultRef = useRef<ConsentResult | null>(null);
  /** Pending "the agent has gone" check; see AGENT_LEFT_GRACE_MS. */
  const agentLeftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        const pub = await room.localParticipant.setScreenShareEnabled(false);
        // The SDK emits the unpublish synchronously inside that call, and the listener
        // consumes the reason. No publication came back means there was nothing to take
        // down, no event fired, and nothing was reported -- so the reason must be dropped
        // here. A latched reason would be spent on the NEXT stop, attributing the caller's
        // own browser-bar stop to whoever asked for this one.
        if (!pub) {
          stopReasonRef.current = null;
        }
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
    // One picker at a time. A second accept would open a second capture whose publication
    // the SDK resolves to the same track, and the loser of the ownership check below would
    // then tear down the winner's live share -- the very defect this check exists to stop.
    // The overlay disables the button while capturing; this makes that a convenience
    // rather than the thing the invariant rests on.
    if (!pending || capturingRef.current) {
      return;
    }
    capturingRef.current = true;
    try {
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
            // Unpublishing failed, so stop the capture at the source instead. Ending a
            // MediaStreamTrack cannot fail the way an SDK round trip can, and a stopped
            // track is a dead capture whatever the room state says.
            try {
              room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track?.stop();
            } catch (err) {
              console.error('[screenshare] could not stop the underlying capture', err);
            }
            console.error(
              '[screenshare] a screen track was published after the request was already answered; the capture was stopped at the source'
            );
          }
        }
        // Only clear an overlay that is still this request's. A newer request may already
        // be on screen, and tearing it off would leave the caller no way to answer it.
        if (pendingRef.current === null) {
          setConsentRequest(null);
        }
        return;
      }

      setIsSharing(response.result === 'granted');
      settle(response);
    } finally {
      capturingRef.current = false;
    }
  }, [accept, room, settle, stopShare]);

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
      const asked = askedWindowSeconds(payload.timeout_seconds);
      const timeoutSeconds = consentWindowSeconds(payload.timeout_seconds, data?.responseTimeout);
      if (timeoutSeconds < asked) {
        // Compared against the resolved ask, not the raw field: an absent `timeout_seconds`
        // is NaN, and `NaN > 9` is false, which would truncate the default in silence.
        console.warn(
          `[screenshare] consent prompt shortened to ${timeoutSeconds}s from ${asked}s; the agent is listening for only ${data?.responseTimeout}ms`
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

      // A still-live track is the more consequential fact, so it is the one reported: a
      // peer with both problems needs to know the screen is still being shared far more
      // than it needs to know its version stamp was wrong.
      if (!stopped) {
        // Never answer `stopped: true` for a stop that did not happen.
        throw new RpcError(
          RpcError.ErrorCode.APPLICATION_ERROR,
          'screenshare.stop: the screen track could not be stopped'
        );
      }
      if (!versionOk) {
        throw new RpcError(
          RpcError.ErrorCode.UNSUPPORTED_VERSION,
          'screenshare.stop: protocol_version_mismatch'
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
      // A reconnect is not a stop. `republishAllTracks` unpublishes every local track and
      // publishes it straight back, so an unpublish that lands while the room is not
      // connected would report a share that is still live -- and, because the track
      // returns, a SECOND stop would then be reported when it really does end. The room
      // ending is handled by `onDisconnected` below.
      if (room.state !== 'connected') {
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

  // A share whose only viewer has gone is over. It is routed through `stopShare` rather
  // than reported directly, so the end travels the SAME single path as every other stop:
  // one unpublish, one `onStopped`, one notification. Reporting it here as well would
  // double-count exactly the share the caller most needs told about accurately.
  useEffect(() => {
    if (!room) {
      return;
    }
    const clearPending = () => {
      if (agentLeftTimerRef.current) {
        clearTimeout(agentLeftTimerRef.current);
        agentLeftTimerRef.current = null;
      }
    };

    /**
     * Everything is re-checked rather than assumed, because both callers exist precisely
     * for the case where the situation changes before this runs.
     *
     * `stopReasonRef` is the single-notify guard: it is non-null from the moment a stop is
     * asked for until the unpublish listener consumes it, so a second call inside that
     * window cannot start a second teardown of the same share.
     */
    const reportAgentGone = () => {
      const stillAway = !Array.from(room.remoteParticipants?.values() ?? []).some((remote) =>
        isAgentParticipant(remote as AgentParticipantLike)
      );
      if (room.state !== 'connected' || !stillAway || stopReasonRef.current) {
        return;
      }
      // Nothing published means nothing to stop: `setScreenShareEnabled(false)` would
      // emit no unpublish, and a stop would be reported for a share that never was.
      if (!room.localParticipant.getTrackPublication(Track.Source.ScreenShare)) {
        return;
      }
      void stopShare('agent_left');
    };

    const onParticipantDisconnected = (participant: AgentParticipantLike) => {
      if (!isAgentParticipant(participant) || agentLeftTimerRef.current) {
        return;
      }
      agentLeftTimerRef.current = setTimeout(() => {
        agentLeftTimerRef.current = null;
        reportAgentGone();
      }, AGENT_LEFT_GRACE_MS);
    };

    // A reconnect that outlasts the grace window would otherwise lose the departure
    // entirely: the timer fires while the room is still reconnecting, declines to report,
    // and nulls itself -- and the SDK does not re-emit ParticipantDisconnected for a
    // participant that never came back, so nothing would ever re-arm. By the time
    // Reconnected is emitted the connection state is already `connected` and
    // `remoteParticipants` has been repopulated from the join response, so absence here is
    // the real thing rather than a gap mid-restart.
    const onReconnected = () => {
      clearPending();
      reportAgentGone();
    };

    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, clearPending);
    return () => {
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, clearPending);
      clearPending();
    };
  }, [room, stopShare]);

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

  return {
    isSharing,
    agentReady,
    // All three conditions, and the agent one is not decoration: without it a caller can
    // start a share nobody is listening for, producing a screen track against no consent
    // record at all.
    canShare: (options.enabled ?? false) && capable && agentReady,
    consentRequest,
    acceptConsent,
    declineConsent,
    startShare,
    stopShare,
  };
}

export default useScreenshareSession;
