// TLZ-561 review I-3/I-4.
//
// Two things that both hinge on "what can this document actually do", and were both
// getting the wrong answer:
//
//  - Permissions-Policy: `display-capture` defaults to an allowlist of `self`, so a
//    customer wrapping the popup in their own cross-origin iframe (or sending a
//    restrictive header) has capture switched off for the document. getDisplayMedia then
//    rejects with NotAllowedError — the SAME error a caller dismissing the picker
//    produces — so those sessions showed the consent prompt, opened nothing, and recorded
//    `cancelled` as though the caller had declined.
//
//  - Safari: livekit-client documents that on Safari 17 "specifying any resolution at all
//    would lead to a low-resolution capture" (WebKit bug 263015), and its own default is
//    uncapped there. Unreadable text defeats the feature, so the constraint is omitted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canCaptureDisplay, isSafari } from '@/lib/screenshare-capability';

function stubEnv(opts: { ua?: string; policyAllows?: boolean | 'no-api' | 'no-document' }) {
  vi.stubGlobal('navigator', {
    userAgent: opts.ua ?? 'Mozilla/5.0 (Macintosh) Chrome/120',
    mediaDevices: { getDisplayMedia: () => {} },
    maxTouchPoints: 0,
  });
  if (opts.policyAllows === 'no-document') {
    vi.stubGlobal('document', undefined);
    return;
  }
  if (opts.policyAllows === 'no-api' || opts.policyAllows === undefined) {
    vi.stubGlobal('document', {});
    return;
  }
  vi.stubGlobal('document', {
    featurePolicy: {
      allowsFeature: (feature: string) =>
        feature === 'display-capture' ? opts.policyAllows : true,
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('canCaptureDisplay — Permissions-Policy', () => {
  it('is false when the document is affirmatively forbidden from capturing a display', () => {
    stubEnv({ policyAllows: false });
    expect(canCaptureDisplay()).toBe(false);
  });

  it('is true when the policy explicitly allows it', () => {
    stubEnv({ policyAllows: true });
    expect(canCaptureDisplay()).toBe(true);
  });

  it('is unchanged where the (non-standard, Chromium-only) API is absent', () => {
    // Deliberately one-way: only an explicit `false` suppresses the offer. Firefox and
    // Safari expose no featurePolicy at all and must behave exactly as before.
    stubEnv({ policyAllows: 'no-api' });
    expect(canCaptureDisplay()).toBe(true);
  });

  it('does not throw when document is absent, as during SSR', () => {
    stubEnv({ policyAllows: 'no-document' });
    expect(() => canCaptureDisplay()).not.toThrow();
  });
});

describe('isSafari', () => {
  it('is true for desktop Safari', () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    });
    expect(isSafari()).toBe(true);
  });

  it('is false for Chrome, which also carries a Safari token', () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    expect(isSafari()).toBe(false);
  });

  it('is false for Edge', () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    });
    expect(isSafari()).toBe(false);
  });

  it('is false for Android Chrome', () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    });
    expect(isSafari()).toBe(false);
  });

  it('does not throw when navigator is absent, as during SSR', () => {
    vi.stubGlobal('navigator', undefined);
    expect(() => isSafari()).not.toThrow();
    expect(isSafari()).toBe(false);
  });
});
