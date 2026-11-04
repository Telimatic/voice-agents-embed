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

// ── Takeover + display push (TLZ-561 remaining epics, spec §5) ─────────────────────────

/** Agent to widget. */
export const RPC_TAKEOVER_REQUEST_VIEWER_CONSENT = 'takeover.requestViewerConsent';
export const RPC_DISPLAY_PUSH = 'display.push';
export const RPC_DISPLAY_HIGHLIGHT = 'display.highlight';
export const RPC_DISPLAY_CLEAR = 'display.clear';
/** Widget to agent. */
export const RPC_DISPLAY_NOTIFY = 'display.notify';

/** Minted by the dashboard into rep/observer tokens. */
export const ATTR_ROLE = 'telzino.role';
export const ATTR_DISPLAY_NAME = 'telzino.display_name';

/** Byte stream topic, widget to agent. */
export const PHOTO_TOPIC = 'telzino.photo';
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const VIEWER_CONSENT_TIMEOUT_S = 30;

export type ViewerRole = 'rep' | 'observer';
export type ViewerConsentOutcome = 'granted' | 'declined' | 'timeout' | 'no_share';
export type DisplayKind = 'url' | 'image' | 'pdf' | 'payment' | 'steps';
export type DisplayPushError = 'not_allowlisted' | 'bad_payload';
export type DisplayNotifyEvent = 'dismissed' | 'minimized' | 'reopened' | 'payment_opened';

export interface ViewerConsentRequest {
  v: number;
  viewer: { identity: string; name: string; role: ViewerRole };
}
export interface ViewerConsentResponse {
  v: number;
  outcome: ViewerConsentOutcome;
}
export interface DisplayPushPayload {
  v: number;
  id: string;
  kind: DisplayKind;
  title: string;
  url?: string;
  steps?: string[];
  amount_label?: string;
}
export interface DisplayPushResponse {
  v: number;
  ok: boolean;
  error?: DisplayPushError;
}
export interface DisplayHighlightPayload {
  v: number;
  id: string;
  step?: number;
  /** 0-1 normalized. */
  region?: { x: number; y: number; w: number; h: number };
}
export interface DisplayHighlightResponse {
  v: number;
  ok: boolean;
}
export interface DisplayClearPayload {
  v: number;
}
export interface DisplayNotifyPayload {
  v: number;
  event: DisplayNotifyEvent;
  id: string;
}

export const VIEWER_ROLES: readonly ViewerRole[] = ['rep', 'observer'];
export const VIEWER_CONSENT_OUTCOMES: readonly ViewerConsentOutcome[] = [
  'granted',
  'declined',
  'timeout',
  'no_share',
];
export const DISPLAY_KINDS: readonly DisplayKind[] = ['url', 'image', 'pdf', 'payment', 'steps'];
export const DISPLAY_PUSH_ERRORS: readonly DisplayPushError[] = ['not_allowlisted', 'bad_payload'];
export const DISPLAY_NOTIFY_EVENTS: readonly DisplayNotifyEvent[] = [
  'dismissed',
  'minimized',
  'reopened',
  'payment_opened',
];

const MAX_STEPS = 10;
const URL_KINDS: readonly DisplayKind[] = ['url', 'image', 'pdf', 'payment'];

type Rec = Record<string, unknown>;
const isRec = (p: unknown): p is Rec => typeof p === 'object' && p !== null && !Array.isArray(p);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isNonEmptyStr = (x: unknown): x is string => isStr(x) && x.length > 0;
const oneOf = <T extends string>(list: readonly T[], x: unknown): x is T =>
  isStr(x) && (list as readonly string[]).includes(x);
const ver = (p: unknown): p is Rec => isRec(p) && isCurrentVersion(p);

export const isViewerConsentRequest = (p: unknown): p is ViewerConsentRequest =>
  ver(p) &&
  isRec(p.viewer) &&
  isNonEmptyStr(p.viewer.identity) &&
  isStr(p.viewer.name) &&
  oneOf(VIEWER_ROLES, p.viewer.role);

export const isViewerConsentResponse = (p: unknown): p is ViewerConsentResponse =>
  ver(p) && oneOf(VIEWER_CONSENT_OUTCOMES, p.outcome);

/** Same rules as the worker's `build_display_push`: https only, 1-10 non-empty steps. */
export function isDisplayPushPayload(p: unknown): p is DisplayPushPayload {
  if (!ver(p) || !isNonEmptyStr(p.id) || !oneOf(DISPLAY_KINDS, p.kind) || !isStr(p.title)) {
    return false;
  }
  if (p.amount_label !== undefined && !isStr(p.amount_label)) return false;
  if (p.kind === 'steps') {
    return (
      Array.isArray(p.steps) &&
      p.steps.length >= 1 &&
      p.steps.length <= MAX_STEPS &&
      p.steps.every((step) => isStr(step) && step.trim().length > 0)
    );
  }
  return (
    (URL_KINDS as readonly string[]).includes(p.kind) &&
    isStr(p.url) &&
    p.url.startsWith('https://')
  );
}

export const isDisplayPushResponse = (p: unknown): p is DisplayPushResponse =>
  ver(p) && typeof p.ok === 'boolean' && (p.error == null || oneOf(DISPLAY_PUSH_ERRORS, p.error));

const isUnit = (x: unknown): x is number => typeof x === 'number' && x >= 0 && x <= 1;

export const isDisplayHighlightPayload = (p: unknown): p is DisplayHighlightPayload =>
  ver(p) &&
  isNonEmptyStr(p.id) &&
  // Exactly one target: a step or a region, never neither or both.
  (p.step === undefined) !== (p.region === undefined) &&
  (p.step === undefined || (Number.isInteger(p.step) && (p.step as number) >= 0)) &&
  (p.region === undefined ||
    (isRec(p.region) &&
      isUnit(p.region.x) &&
      isUnit(p.region.y) &&
      isUnit(p.region.w) &&
      isUnit(p.region.h)));

export const isDisplayHighlightResponse = (p: unknown): p is DisplayHighlightResponse =>
  ver(p) && typeof p.ok === 'boolean';

export const isDisplayClearPayload = (p: unknown): p is DisplayClearPayload => ver(p);

export const isDisplayNotifyPayload = (p: unknown): p is DisplayNotifyPayload =>
  ver(p) && oneOf(DISPLAY_NOTIFY_EVENTS, p.event) && isNonEmptyStr(p.id);
