// TLZ-561. Whether this browser can capture a display at all.
//
// The answer is reported to the token route and stamped into the access token as the
// `telzino.screenshare.capable` participant attribute, so the agent knows BEFORE it offers
// rather than after the caller has already agreed to something their browser cannot do.
// (It used to be written by the participant itself via setAttributes; see
// app/api/connection-details/route.ts for why that permission had to go.)

/** iOS proper, where the device is named in the user agent. */
const IOS_DEVICE = /iPad|iPhone|iPod/;

/** A Mac-shaped user agent. iPadOS Safari sends one of these. */
const MAC_LIKE = /Mac/;

/**
 * A version token no iOS browser can produce. Every engine on iOS is WebKit, and the
 * ported browsers identify themselves as CriOS / EdgiOS / FxiOS -- or, in "request
 * desktop site" mode, as plain Safari. A real `Chrome/120` or `Firefox/128` token
 * therefore rules iOS out, which is what separates a genuine Mac from an iPad.
 */
const DESKTOP_ENGINE = /\b(?:Chrome|Chromium|Firefox)\/\d/;

/**
 * iPadOS reports itself as a Mac and offers a `getDisplayMedia` that always rejects.
 * A touch-capable "Mac" running a WebKit-only browser is the only reliable tell:
 * no real Mac reports more than one touch point.
 */
function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  if (IOS_DEVICE.test(userAgent)) {
    return true;
  }
  return MAC_LIKE.test(userAgent) && maxTouchPoints > 1 && !DESKTOP_ENGINE.test(userAgent);
}

/**
 * True only where a display capture can actually succeed.
 *
 * Deliberately conservative: a false negative costs the caller a feature they were
 * never offered, while a false positive costs them a failed capture after they have
 * already said yes -- and leaves the agent waiting on a share that will never arrive.
 */
export function canCaptureDisplay(): boolean {
  // `navigator` is absent during SSR, and vi.stubGlobal can set it to undefined.
  if (typeof navigator === 'undefined' || !navigator) {
    return false;
  }

  if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
    return false;
  }

  if (!displayCaptureAllowedByPolicy()) {
    return false;
  }

  return !isAppleMobile(navigator.userAgent ?? '', navigator.maxTouchPoints ?? 0);
}

/**
 * False only when the document is affirmatively KNOWN to be forbidden from capturing a
 * display by Permissions-Policy.
 *
 * `display-capture` defaults to an allowlist of `self`, so a customer who wraps the popup
 * in their own cross-origin iframe — or sends a restrictive `Permissions-Policy` header —
 * has the feature switched off for this document. `getDisplayMedia()` then rejects with
 * `NotAllowedError`, which is the SAME error a caller dismissing the picker produces: the
 * widget showed the consent prompt, opened nothing, and wrote `cancelled` to the audit row
 * as though the caller had declined.
 *
 * `document.featurePolicy` is non-standard and Chromium-only, so this is deliberately a
 * one-way test: an explicit `false` suppresses the offer, and everything else (including
 * every browser without the API) leaves behaviour exactly as it was.
 */
function displayCaptureAllowedByPolicy(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }
  const policy = (
    document as Document & {
      featurePolicy?: { allowsFeature?: (feature: string) => boolean };
    }
  ).featurePolicy;
  return policy?.allowsFeature?.('display-capture') !== false;
}

/**
 * Safari, any version.
 *
 * Used only to decide whether to pass a capture `resolution`. livekit-client documents
 * (room/track/options.d.ts): "On Safari 17, default resolution is not capped, due to a
 * bug, specifying any resolution at all would lead to a low-resolution capture"
 * (WebKit bug 263015) — and its own default is already "1080 for all browsers OTHER than
 * Safari", so omitting the constraint here matches what the SDK would do anyway. A
 * low-resolution capture makes on-screen text unreadable, which is the entire feature.
 *
 * `isSafari17Based()` exists inside livekit-client but is not exported from the package
 * root, so this is detected here rather than imported. Version is not parsed: the cost of
 * omitting the constraint on an older Safari is the SDK's own default.
 */
export function isSafari(): boolean {
  if (typeof navigator === 'undefined' || !navigator) {
    return false;
  }
  const ua = navigator.userAgent ?? '';
  return /Safari\//.test(ua) && !/\b(?:Chrome|Chromium|Android|Edg)\//.test(ua);
}
