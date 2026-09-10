// TLZ-561. The wire contract between the widget and the agent. Mirrored in
// livekit-agent-worker/screenshare_protocol.py; both sides assert against
// fixtures/screenshare-protocol.fixture.json so a change on one side fails the other.
//
// Transport is LiveKit RPC plus participant attributes. Track publish and unpublish
// events remain the source of truth for media state; these messages carry intent,
// outcome and attribution, which the track events cannot express.

export const SCREENSHARE_PROTOCOL_VERSION = 1;

/** Agent to widget. */
export const RPC_REQUEST_CONSENT = 'screenshare.requestConsent';
export const RPC_STOP = 'screenshare.stop';
/** Widget to agent. */
export const RPC_NOTIFY = 'screenshare.notify';

/** Set by the widget once it knows whether this browser can capture a display. */
export const ATTR_CAPABLE = 'telzino.screenshare.capable';
/** Set by the agent from the session resolver. */
export const ATTR_ENABLED = 'telzino.screenshare.enabled';

export type ShareSurface = 'browser' | 'window' | 'monitor';

/**
 * The canonical list, in preference order (least invasive first). The single definition
 * for this repo — it used to be declared three times (here implicitly via the type, plus
 * two runtime copies: `KNOWN_SURFACES` in embed-config-client.ts and `SURFACE_PREFERENCE`
 * in use-screenshare-session.ts), all required to agree by hand. Order matters here, not
 * just membership: `preferredSurface` walks this list to pick the least invasive surface
 * the caller's policy allows.
 *
 * Mirrored in fixtures/screenshare-protocol.fixture.json's `enums.shareSurface` (asserted
 * in screenshare-protocol.test.ts) and, necessarily, in the dashboard's own
 * app/api/embed/widget-config/route.ts and the worker's screenshare_protocol.py — neither
 * of those can import this module, so they stay separate definitions checked for parity by
 * the same fixture, the way the rest of this protocol already works across repos.
 */
export const SHARE_SURFACES: readonly ShareSurface[] = ['browser', 'window', 'monitor'];

/**
 * Why a consent request ended. `granted` is only ever sent AFTER the track is published,
 * so the agent never waits on a share the caller silently cancelled in the picker.
 */
export type ConsentResult =
  | 'granted' // caller accepted and the screen track is live
  | 'declined' // caller pressed Not now
  | 'timeout' // the prompt expired untouched
  | 'cancelled' // caller accepted, then dismissed the browser picker
  | 'failed' // capture threw
  | 'unsupported'; // this browser cannot capture a display

export type StopReason = 'caller_stop' | 'browser_stop' | 'agent_end' | 'agent_left';

export interface RequestConsentPayload {
  v: number;
  scope: ShareSurface[];
  viewers: { role: 'agent' }[];
  timeout_seconds: number;
}

export interface RequestConsentResponse {
  v: number;
  result: ConsentResult;
  surface?: ShareSurface;
  track_sid?: string;
  reason?: string;
}

export interface StopPayload {
  v: number;
}
export interface StopResponse {
  v: number;
  stopped: true;
}

export interface NotifyPayload {
  v: number;
  event: 'consent' | 'started' | 'stopped' | 'failed';
  initiated_by: 'agent' | 'caller';
  result?: ConsentResult;
  surface?: ShareSurface;
  track_sid?: string;
  reason?: StopReason | string;
}

export interface NotifyResponse {
  v: number;
  ok: true;
}

/** Every message is version-stamped; a mismatched peer is ignored rather than guessed at. */
export function isCurrentVersion(payload: { v?: unknown }): boolean {
  return payload?.v === SCREENSHARE_PROTOCOL_VERSION;
}
