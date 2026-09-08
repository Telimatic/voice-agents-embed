import type { ReactNode } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomContext } from '@livekit/components-react';
// eslint-plugin-import cannot follow @testing-library/react's export map; `waitFor`
// is exported and resolves at runtime.
// eslint-disable-next-line import/named
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  MAX_CONSENT_TIMEOUT_SECONDS,
  type UseScreenshareSessionOptions,
  useScreenshareSession,
} from '@/hooks/use-screenshare-session';
import {
  ATTR_CAPABLE,
  RPC_REQUEST_CONSENT,
  RPC_STOP,
  type RequestConsentResponse,
  SCREENSHARE_PROTOCOL_VERSION,
  type ShareSurface,
  type StopReason,
  type StopResponse,
} from '@/lib/screenshare-protocol';

type RpcHandler = (data: {
  requestId: string;
  callerIdentity: string;
  payload: string;
  responseTimeout: number;
}) => Promise<string>;

const CAPABLE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36';

function stubNavigator({ capable }: { capable: boolean }) {
  vi.stubGlobal('navigator', {
    userAgent: capable
      ? CAPABLE_UA
      : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari',
    mediaDevices: { getDisplayMedia: () => {} },
    maxTouchPoints: capable ? 0 : 5,
  });
}

function fakePublication(displaySurface: string | undefined, trackSid = 'TR_screen_1') {
  return {
    trackSid,
    source: Track.Source.ScreenShare,
    track: {
      stop: vi.fn(),
      mediaStreamTrack: { getSettings: () => ({ displaySurface }) },
    },
  };
}

/**
 * Behaves like the SDK in the two ways this hook depends on: `setScreenShareEnabled(false)`
 * resolves to the publication it took down (or `undefined` when there was nothing to take
 * down), and the unpublish event fires synchronously inside that call.
 */
function createFakeRoom() {
  const rpcHandlers = new Map<string, RpcHandler>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let published: ReturnType<typeof fakePublication> | undefined;

  const setScreenShareEnabled = vi.fn(
    async (
      ...args: [enabled: boolean, options?: Record<string, unknown>]
    ): Promise<ReturnType<typeof fakePublication> | undefined> => {
      if (args[0]) {
        published = fakePublication('window');
        return published;
      }
      const wasPublished = published;
      published = undefined;
      if (wasPublished) {
        room.emit(RoomEvent.LocalTrackUnpublished, wasPublished);
      }
      return wasPublished;
    }
  );
  const getTrackPublication = vi.fn(() => published);
  const setAttributes = vi.fn(async () => undefined);

  const room = {
    state: 'connected',
    localParticipant: { setScreenShareEnabled, setAttributes, getTrackPublication },
    registerRpcMethod: vi.fn((method: string, handler: RpcHandler) => {
      rpcHandlers.set(method, handler);
    }),
    unregisterRpcMethod: vi.fn((method: string) => {
      rpcHandlers.delete(method);
    }),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return room;
    }),
    off: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(cb);
      return room;
    }),
    emit: (event: string, ...args: unknown[]) => {
      listeners.get(event)?.forEach((cb) => cb(...args));
    },
  };

  return {
    room,
    rpcHandlers,
    setScreenShareEnabled,
    setAttributes,
    getTrackPublication,
    /** Mirrors the SDK: once the picker resolves, the publication exists on the participant. */
    setPublished: (pub: ReturnType<typeof fakePublication> | undefined) => {
      published = pub;
    },
  };
}

/**
 * Hold the browser picker open. The promise stays unresolved until `release`, which is how
 * every "something answered while the caller was still choosing" case is driven.
 */
function holdPicker(fake: ReturnType<typeof createFakeRoom>) {
  let resolvePicker!: (pub: ReturnType<typeof fakePublication> | undefined) => void;
  fake.setScreenShareEnabled.mockImplementationOnce(
    () =>
      new Promise<ReturnType<typeof fakePublication> | undefined>((resolve) => {
        resolvePicker = resolve;
      })
  );
  return {
    release: (pub = fakePublication('monitor', 'TR_late')) => {
      fake.setPublished(pub);
      resolvePicker(pub);
      return pub;
    },
  };
}

type FakeRoom = ReturnType<typeof createFakeRoom>['room'];

function renderSession(room: FakeRoom, options: UseScreenshareSessionOptions = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RoomContext.Provider value={room as unknown as Room}>{children}</RoomContext.Provider>
  );
  // The token route said this organization has the feature unless a test says otherwise.
  return renderHook(() => useScreenshareSession({ enabled: true, ...options }), { wrapper });
}

function consentPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    v: SCREENSHARE_PROTOCOL_VERSION,
    scope: ['browser', 'window', 'monitor'],
    viewers: [{ role: 'agent' }],
    timeout_seconds: 30,
    ...overrides,
  });
}

function invokeConsent(handler: RpcHandler, payload = consentPayload(), responseTimeout = 45_000) {
  return handler({
    requestId: 'req_1',
    callerIdentity: 'agent',
    payload,
    responseTimeout,
  });
}

function invokeStop(
  handler: RpcHandler,
  payload = JSON.stringify({ v: SCREENSHARE_PROTOCOL_VERSION })
) {
  return handler({
    requestId: 'req_2',
    callerIdentity: 'agent',
    payload,
    responseTimeout: 10_000,
  });
}

async function parse(promise: Promise<string>): Promise<RequestConsentResponse> {
  return JSON.parse(await promise);
}

/** Drive one consent request all the way to a published track. */
async function shareUntilGranted(
  rpcHandlers: Map<string, RpcHandler>,
  hook: ReturnType<typeof renderSession>
) {
  const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
  await waitFor(() => expect(hook.result.current.consentRequest).not.toBeNull());
  await act(async () => {
    await hook.result.current.acceptConsent();
  });
  await rpc;
  return rpc;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useScreenshareSession', () => {
  beforeEach(() => stubNavigator({ capable: true }));

  it('advertises the capability attribute and registers both RPC methods on connect', async () => {
    const { room, rpcHandlers, setAttributes } = createFakeRoom();
    renderSession(room);

    await waitFor(() => expect(setAttributes).toHaveBeenCalledWith({ [ATTR_CAPABLE]: 'true' }));
    expect(rpcHandlers.has(RPC_REQUEST_CONSENT)).toBe(true);
    expect(rpcHandlers.has(RPC_STOP)).toBe(true);
  });

  it('answers granted with the surface actually chosen and the track sid, only after publish', async () => {
    const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
    const { result } = renderSession(room);

    const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
    // Nothing has been answered yet: the prompt is still open.
    expect(setScreenShareEnabled).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.acceptConsent();
    });

    const response = await parse(rpc);
    expect(response).toEqual({
      v: SCREENSHARE_PROTOCOL_VERSION,
      result: 'granted',
      surface: 'window',
      track_sid: 'TR_screen_1',
    });
    expect(result.current.isSharing).toBe(true);
    expect(result.current.consentRequest).toBeNull();

    // The requested displaySurface is only a hint; tab audio is never captured.
    const options = setScreenShareEnabled.mock.calls[0][1] as Record<string, unknown>;
    expect(options.audio).toBe(false);
    expect(options.video).toEqual({ displaySurface: 'browser' });
  });

  it('reports the surface the caller actually picked, not the one requested', async () => {
    const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
    setScreenShareEnabled.mockResolvedValueOnce(fakePublication('monitor', 'TR_screen_9'));
    const { result } = renderSession(room);

    const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
    await act(async () => {
      await result.current.acceptConsent();
    });

    const response = await parse(rpc);
    expect(response.surface).toBe('monitor');
    expect(response.track_sid).toBe('TR_screen_9');
  });

  it('answers cancelled when the caller dismisses the browser picker', async () => {
    const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    setScreenShareEnabled.mockRejectedValueOnce(denied);
    const { result } = renderSession(room);

    const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
    await act(async () => {
      await result.current.acceptConsent();
    });

    const response = await parse(rpc);
    expect(response.result).toBe('cancelled');
    expect(response.reason).toBe('NotAllowedError');
    expect(result.current.isSharing).toBe(false);
  });

  it('answers failed when the capture throws for any other reason', async () => {
    const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
    const broken = Object.assign(new Error('no capture device'), { name: 'NotFoundError' });
    setScreenShareEnabled.mockRejectedValueOnce(broken);
    const { result } = renderSession(room);

    const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
    await act(async () => {
      await result.current.acceptConsent();
    });

    const response = await parse(rpc);
    expect(response.result).toBe('failed');
    expect(response.reason).toBe('NotFoundError');
  });

  it('answers failed when the publish resolves without a publication', async () => {
    const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
    setScreenShareEnabled.mockResolvedValueOnce(undefined);
    const { result } = renderSession(room);

    const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
    await act(async () => {
      await result.current.acceptConsent();
    });

    const response = await parse(rpc);
    expect(response.result).toBe('failed');
    expect(response.reason).toBe('no_publication');
    expect(result.current.isSharing).toBe(false);
  });

  it('answers declined when the caller presses Not now, without opening a picker', async () => {
    const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
    const { result } = renderSession(room);

    const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
    act(() => result.current.declineConsent());

    const response = await parse(rpc);
    expect(response.result).toBe('declined');
    expect(setScreenShareEnabled).not.toHaveBeenCalled();
    expect(result.current.consentRequest).toBeNull();
  });

  it('answers timeout when the prompt is left untouched for 30 seconds', async () => {
    vi.useFakeTimers();
    try {
      const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
      const { result } = renderSession(room);

      const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.consentRequest?.timeoutSeconds).toBe(30);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      const response = await parse(rpc);
      expect(response.result).toBe('timeout');
      expect(setScreenShareEnabled).not.toHaveBeenCalled();
      expect(result.current.consentRequest).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers unsupported on a device that cannot capture, without ever opening a picker', async () => {
    stubNavigator({ capable: false });
    const { room, rpcHandlers, setScreenShareEnabled, setAttributes } = createFakeRoom();
    const { result } = renderSession(room);

    await waitFor(() => expect(setAttributes).toHaveBeenCalledWith({ [ATTR_CAPABLE]: 'false' }));

    const response = await parse(invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!));
    expect(response.result).toBe('unsupported');
    expect(setScreenShareEnabled).not.toHaveBeenCalled();
    expect(result.current.consentRequest).toBeNull();
  });

  it('never prompts an organization the token did not grant screenshare to', async () => {
    const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
    const { result } = renderSession(room, { enabled: false });

    const response = await parse(invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!));
    expect(response.result).toBe('failed');
    expect(response.reason).toBe('not_permitted');
    expect(result.current.consentRequest).toBeNull();
    expect(setScreenShareEnabled).not.toHaveBeenCalled();

    // ...and the caller cannot start one from the widget side either.
    let started: RequestConsentResponse | undefined;
    await act(async () => {
      started = await result.current.startShare();
    });
    expect(started?.reason).toBe('not_permitted');
    expect(setScreenShareEnabled).not.toHaveBeenCalled();
  });

  it('refuses a request stamped with a different protocol version', async () => {
    const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
    renderSession(room);

    const response = await parse(
      invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!, consentPayload({ v: 99 }))
    );
    expect(response.result).toBe('failed');
    expect(response.reason).toBe('protocol_version_mismatch');
    expect(setScreenShareEnabled).not.toHaveBeenCalled();
  });

  it('narrows the offered surfaces to what policy allows', async () => {
    const { room, rpcHandlers } = createFakeRoom();
    const surfaces: ShareSurface[] = ['window'];
    const { result } = renderSession(room, { allowedSurfaces: surfaces });

    invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
    expect(result.current.consentRequest?.surfaces).toEqual(['window']);
  });

  describe('the prompt window', () => {
    it('never outlives the response timeout the agent is listening on', async () => {
      const { room, rpcHandlers } = createFakeRoom();
      const { result } = renderSession(room);

      // LiveKit's default responseTimeout is 10s; a 30s prompt would answer into the void.
      invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!, consentPayload(), 10_000);
      await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
      expect(result.current.consentRequest?.timeoutSeconds).toBe(9);
    });

    it('bounds a timeout_seconds the peer sends rather than trusting it', async () => {
      const { room, rpcHandlers } = createFakeRoom();
      const { result } = renderSession(room);

      invokeConsent(
        rpcHandlers.get(RPC_REQUEST_CONSENT)!,
        consentPayload({ timeout_seconds: 99_999 }),
        600_000
      );
      await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
      expect(result.current.consentRequest?.timeoutSeconds).toBe(MAX_CONSENT_TIMEOUT_SECONDS);
    });

    it('says so when it shortens the default window', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { room, rpcHandlers } = createFakeRoom();
      const { result } = renderSession(room);

      // No `timeout_seconds` at all. Comparing the raw field would compare NaN, and the
      // default would be cut from 30s to 9s in silence.
      invokeConsent(
        rpcHandlers.get(RPC_REQUEST_CONSENT)!,
        consentPayload({ timeout_seconds: undefined }),
        10_000
      );
      await waitFor(() => expect(result.current.consentRequest).not.toBeNull());

      expect(result.current.consentRequest?.timeoutSeconds).toBe(9);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('shortened to 9s from 30s'));
    });
  });

  describe('screenshare.stop', () => {
    it('stops the track and closes an open prompt, attributing the end to the agent', async () => {
      const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
      const { result } = renderSession(room);

      const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
      await waitFor(() => expect(result.current.consentRequest).not.toBeNull());

      let stopRaw = '';
      await act(async () => {
        stopRaw = await invokeStop(rpcHandlers.get(RPC_STOP)!);
      });
      const stopped: StopResponse = JSON.parse(stopRaw);

      expect(stopped).toEqual({ v: SCREENSHARE_PROTOCOL_VERSION, stopped: true });
      expect(setScreenShareEnabled).toHaveBeenCalledWith(false);

      // `cancelled` is the caller's own dismissal. An agent-side withdrawal is not that.
      const response = await parse(rpc);
      expect(response.result).toBe('failed');
      expect(response.reason).toBe('agent_end');
      expect(result.current.consentRequest).toBeNull();
    });

    it('does not report a stop that did not happen', async () => {
      const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
      const hook = renderSession(room);
      await shareUntilGranted(rpcHandlers, hook);
      expect(hook.result.current.isSharing).toBe(true);

      setScreenShareEnabled.mockRejectedValueOnce(new Error('track is stuck'));
      await act(async () => {
        await expect(invokeStop(rpcHandlers.get(RPC_STOP)!)).rejects.toThrow(
          /could not be stopped/
        );
      });

      // The track may still be live, so the widget keeps saying so.
      expect(hook.result.current.isSharing).toBe(true);
    });

    it('stops the track even on a version it does not understand, then reports the mismatch', async () => {
      const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
      const hook = renderSession(room);
      await shareUntilGranted(rpcHandlers, hook);

      // Refusing to START on an unknown version is safe; refusing to STOP is not.
      await act(async () => {
        await expect(
          invokeStop(rpcHandlers.get(RPC_STOP)!, JSON.stringify({ v: 99 }))
        ).rejects.toThrow(/protocol_version_mismatch/);
      });
      expect(setScreenShareEnabled).toHaveBeenLastCalledWith(false);
      expect(hook.result.current.isSharing).toBe(false);
    });

    it('reports a still-live track ahead of a bad version stamp', async () => {
      const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
      const hook = renderSession(room);
      await shareUntilGranted(rpcHandlers, hook);

      setScreenShareEnabled.mockRejectedValueOnce(new Error('track is stuck'));
      // A peer with both problems needs to know the screen is still being shared far
      // more than it needs to know its version stamp was wrong.
      await act(async () => {
        await expect(
          invokeStop(rpcHandlers.get(RPC_STOP)!, JSON.stringify({ v: 99 }))
        ).rejects.toThrow(/could not be stopped/);
      });
      expect(hook.result.current.isSharing).toBe(true);
    });
  });

  describe('no path leaves a live track the agent believes was cancelled', () => {
    it('tears the track down when the agent withdrew while the picker was open', async () => {
      const fake = createFakeRoom();
      const picker = holdPicker(fake);
      const { result } = renderSession(fake.room);

      const rpc = invokeConsent(fake.rpcHandlers.get(RPC_REQUEST_CONSENT)!);
      await waitFor(() => expect(result.current.consentRequest).not.toBeNull());

      let accepting!: Promise<void>;
      await act(async () => {
        accepting = result.current.acceptConsent();
      });
      expect(result.current.consentRequest?.capturing).toBe(true);

      // The agent gives up while the caller is still in the browser's picker.
      await act(async () => {
        await invokeStop(fake.rpcHandlers.get(RPC_STOP)!);
      });
      const response = await parse(rpc);
      expect(response.result).toBe('failed');
      expect(response.reason).toBe('agent_end');

      // ...and only now does the caller finish choosing, publishing a track.
      await act(async () => {
        picker.release();
        await accepting;
      });

      // The agent was told there is no share, so there must not be one.
      expect(fake.setScreenShareEnabled).toHaveBeenLastCalledWith(false);
      expect(result.current.isSharing).toBe(false);
    });

    it('tears the track down when the panel closed while the picker was open', async () => {
      const fake = createFakeRoom();
      const picker = holdPicker(fake);
      const { result, unmount } = renderSession(fake.room);

      const rpc = invokeConsent(fake.rpcHandlers.get(RPC_REQUEST_CONSENT)!);
      await waitFor(() => expect(result.current.consentRequest).not.toBeNull());

      let accepting!: Promise<void>;
      await act(async () => {
        accepting = result.current.acceptConsent();
      });

      unmount();
      const response = await parse(rpc);
      expect(response.result).toBe('failed');
      expect(response.reason).toBe('widget_closed');

      await act(async () => {
        picker.release();
        await accepting;
      });
      expect(fake.setScreenShareEnabled).toHaveBeenLastCalledWith(false);
    });

    it('stops the capture at the source when unpublishing it fails', async () => {
      const fake = createFakeRoom();
      const picker = holdPicker(fake);
      const { result } = renderSession(fake.room);

      const rpc = invokeConsent(fake.rpcHandlers.get(RPC_REQUEST_CONSENT)!);
      await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
      let accepting!: Promise<void>;
      await act(async () => {
        accepting = result.current.acceptConsent();
      });
      await act(async () => {
        await invokeStop(fake.rpcHandlers.get(RPC_STOP)!);
      });
      await rpc;

      // The compensating unpublish is the one thing that can still fail here...
      fake.setScreenShareEnabled.mockRejectedValueOnce(new Error('unpublish failed'));
      let late!: ReturnType<typeof fakePublication>;
      await act(async () => {
        late = picker.release();
        await accepting;
      });

      // ...so the capture is ended at the source, which cannot.
      expect(late.track.stop).toHaveBeenCalledTimes(1);
      expect(result.current.isSharing).toBe(false);
    });

    it('opens only one picker however many times Share is pressed', async () => {
      const fake = createFakeRoom();
      const picker = holdPicker(fake);
      const { result } = renderSession(fake.room);

      const rpc = invokeConsent(fake.rpcHandlers.get(RPC_REQUEST_CONSENT)!);
      await waitFor(() => expect(result.current.consentRequest).not.toBeNull());

      let first!: Promise<void>;
      let second!: Promise<void>;
      await act(async () => {
        first = result.current.acceptConsent();
        second = result.current.acceptConsent();
      });
      // The second press is a no-op rather than a second capture whose loser would tear
      // down the winner's live track.
      expect(fake.setScreenShareEnabled).toHaveBeenCalledTimes(1);

      await act(async () => {
        picker.release();
        await Promise.all([first, second]);
      });

      expect((await parse(rpc)).result).toBe('granted');
      expect(result.current.isSharing).toBe(true);
      expect(fake.setScreenShareEnabled).not.toHaveBeenCalledWith(false);
    });

    it('leaves a newer request on screen when a superseded accept finishes', async () => {
      const fake = createFakeRoom();
      const picker = holdPicker(fake);
      const { result } = renderSession(fake.room);

      const first = invokeConsent(fake.rpcHandlers.get(RPC_REQUEST_CONSENT)!);
      await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
      let accepting!: Promise<void>;
      await act(async () => {
        accepting = result.current.acceptConsent();
      });

      // The agent withdraws and immediately asks again.
      await act(async () => {
        await invokeStop(fake.rpcHandlers.get(RPC_STOP)!);
      });
      await first;
      const second = invokeConsent(fake.rpcHandlers.get(RPC_REQUEST_CONSENT)!);
      await waitFor(() => expect(result.current.consentRequest).not.toBeNull());

      await act(async () => {
        picker.release();
        await accepting;
      });

      // The stale accept must not take the new prompt off the screen: the caller would be
      // left with a request they cannot answer, which would then time out.
      expect(result.current.consentRequest).not.toBeNull();
      act(() => result.current.declineConsent());
      expect((await parse(second)).result).toBe('declined');
    });
  });

  describe('onStopped', () => {
    it('reports the browser bar, the caller and the agent as distinct reasons', async () => {
      const reasons: StopReason[] = [];
      const { room, rpcHandlers } = createFakeRoom();
      const hook = renderSession(room, { onStopped: (reason) => reasons.push(reason) });

      // The browser's own "Stop sharing" bar: the track ends and the SDK unpublishes it,
      // with nothing in this hook having asked. That event is the only real signal.
      await shareUntilGranted(rpcHandlers, hook);
      act(() => {
        room.emit(RoomEvent.LocalTrackUnpublished, fakePublication('window'));
      });
      expect(reasons).toEqual(['browser_stop']);
      expect(hook.result.current.isSharing).toBe(false);

      // The caller pressing stop in the widget -- driven through stopShare, not by
      // emitting the event by hand, so the reason really does travel the way it will live.
      await shareUntilGranted(rpcHandlers, hook);
      await act(async () => {
        await hook.result.current.stopShare();
      });
      expect(reasons).toEqual(['browser_stop', 'caller_stop']);

      // The agent's screenshare.stop, likewise through the handler.
      await shareUntilGranted(rpcHandlers, hook);
      await act(async () => {
        await invokeStop(rpcHandlers.get(RPC_STOP)!);
      });
      expect(reasons).toEqual(['browser_stop', 'caller_stop', 'agent_end']);
    });

    it("never spends an agent stop reason on the caller's next browser stop", async () => {
      const reasons: StopReason[] = [];
      const { room, rpcHandlers } = createFakeRoom();
      const hook = renderSession(room, { onStopped: (reason) => reasons.push(reason) });

      // The agent withdraws while only the PROMPT is open. Nothing is published, so
      // nothing is unpublished and no reason is consumed.
      const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
      await waitFor(() => expect(hook.result.current.consentRequest).not.toBeNull());
      await act(async () => {
        await invokeStop(rpcHandlers.get(RPC_STOP)!);
      });
      expect((await parse(rpc)).reason).toBe('agent_end');
      expect(reasons).toEqual([]);

      // The caller then shares, and stops it from the browser's own bar. If `agent_end`
      // were still latched from the withdrawal above, this would be reported as the
      // agent's doing -- the same attribution falsehood by a slower route.
      await shareUntilGranted(rpcHandlers, hook);
      act(() => {
        room.emit(RoomEvent.LocalTrackUnpublished, fakePublication('window'));
      });
      expect(reasons).toEqual(['browser_stop']);
    });

    it('ignores tracks that are not the screen share', async () => {
      const reasons: StopReason[] = [];
      const { room, rpcHandlers } = createFakeRoom();
      const hook = renderSession(room, { onStopped: (reason) => reasons.push(reason) });
      await shareUntilGranted(rpcHandlers, hook);

      act(() => {
        room.emit(RoomEvent.LocalTrackUnpublished, {
          ...fakePublication('window'),
          source: Track.Source.Camera,
        });
      });
      expect(reasons).toEqual([]);
      expect(hook.result.current.isSharing).toBe(true);
    });
  });

  it('answers an outstanding request rather than dangling when the widget closes', async () => {
    const { room, rpcHandlers } = createFakeRoom();
    const { result, unmount } = renderSession(room);

    const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
    unmount();

    const response = await parse(rpc);
    expect(response.result).toBe('failed');
    expect(response.reason).toBe('widget_closed');
  });
});
