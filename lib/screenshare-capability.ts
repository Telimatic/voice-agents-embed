// TLZ-561. Whether this browser can capture a display at all.
//
// The widget publishes the answer as the `telzino.screenshare.capable` participant
// attribute the moment it connects, so the agent knows BEFORE it offers rather than
// after the caller has already agreed to something their browser cannot do.

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

  return !isAppleMobile(navigator.userAgent ?? '', navigator.maxTouchPoints ?? 0);
}
