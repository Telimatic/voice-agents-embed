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
/**
 * Set by the agent alongside `ATTR_ENABLED`: the surfaces org policy allows, comma-joined
 * in protocol order (`browser,window`). Empty when the agent retracts `enabled`. The widget
 * reads it with `parseAllowedSurfaces`, which falls back to every surface, so an agent that
 * predates this key still works.
 */
export const ATTR_ALLOWED_SURFACES = 'telzino.screenshare.allowed_surfaces';

export type ShareSurface = 'browser' | 'window' | 'monitor';

/**
 * The canonical list, in preference order (least invasive first). The single definition
 * for this repo — it used to be declared three times (here implicitly via the type, plus
 * two runtime copies: `KNOWN_SURFACES` in embed-config-client.ts and `SURFACE_PREFERENCE`
 * in use-screenshare-session.ts), all required to agree by hand. Order matters here, not
 * just membership: `preferredSurface` walks this list to pick the least invasive surface
 * the caller's policy allows.
 *
 * Mirrored in fixtures/screenshare-protocol.fixture.json's enums.shareSurface (asserted in screenshare-protocol.test.ts) and in the worker's screenshare_protocol.py, checked for parity by the same fixture.
 */
export const SHARE_SURFACES: readonly ShareSurface[] = ['browser', 'window', 'monitor'];

/**
 * Parse the `ATTR_ALLOWED_SURFACES` value. Unknown entries are dropped, duplicates
 * collapse, and the result is in protocol order regardless of the wire order. Nothing
 * usable means the full list: this attribute is a hint to the picker, never enforcement.
 */
export function parseAllowedSurfaces(raw: string | undefined): ShareSurface[] {
  const wanted = new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry): entry is ShareSurface => (SHARE_SURFACES as string[]).includes(entry))
  );
  const ordered = SHARE_SURFACES.filter((surface) => wanted.has(surface));
  return ordered.length ? ordered : [...SHARE_SURFACES];
}

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
