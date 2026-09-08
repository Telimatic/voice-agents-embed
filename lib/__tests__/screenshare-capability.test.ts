import { afterEach, describe, expect, it, vi } from 'vitest';
import { canCaptureDisplay } from '@/lib/screenshare-capability';

function withUserAgent(ua: string, hasApi: boolean) {
  vi.stubGlobal('navigator', {
    userAgent: ua,
    mediaDevices: hasApi ? { getDisplayMedia: () => {} } : {},
    maxTouchPoints: 5,
  });
}
afterEach(() => vi.unstubAllGlobals());

describe('canCaptureDisplay', () => {
  it('is true on a desktop browser that exposes getDisplayMedia', () => {
    withUserAgent('Mozilla/5.0 (Macintosh) Chrome/120', true);
    expect(canCaptureDisplay()).toBe(true);
  });

  it('is false when the API is missing', () => {
    withUserAgent('Mozilla/5.0 (Macintosh) Chrome/120', false);
    expect(canCaptureDisplay()).toBe(false);
  });

  it('is false on iOS even when the API appears present', () => {
    // No iOS browser can capture a display, whatever engine it claims; a truthy
    // getDisplayMedia there would only fail later, after the caller had agreed.
    withUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari', true);
    expect(canCaptureDisplay()).toBe(false);
  });

  it('is false on iPadOS, which reports itself as a Mac', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari',
      mediaDevices: { getDisplayMedia: () => {} },
      maxTouchPoints: 5, // the only reliable tell
    });
    expect(canCaptureDisplay()).toBe(false);
  });

  it('does not throw when navigator is absent, as during SSR', () => {
    vi.stubGlobal('navigator', undefined);
    expect(canCaptureDisplay()).toBe(false);
  });
});
