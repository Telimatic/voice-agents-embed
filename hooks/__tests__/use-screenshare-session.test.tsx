import type { ReactNode } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomContext } from '@livekit/components-react';
// eslint-plugin-import cannot follow @testing-library/react's export map; `waitFor`
// is exported and resolves at runtime.
// eslint-disable-next-line import/named
import { act, renderHook, waitFor } from '@testing-library/react';
import { useScreenshareSession } from '@/hooks/use-screenshare-session';
import {
  ATTR_CAPABLE,
  RPC_REQUEST_CONSENT,
  RPC_STOP,
  type RequestConsentResponse,
  SCREENSHARE_PROTOCOL_VERSION,
  type ShareSurface,
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
      mediaStreamTrack: { getSettings: () => ({ displaySurface }) },
    },
  };
}

function createFakeRoom() {
  const rpcHandlers = new Map<string, RpcHandler>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const setScreenShareEnabled = vi.fn(
    async (
      ...args: [enabled: boolean, options?: Record<string, unknown>]
    ): Promise<ReturnType<typeof fakePublication> | undefined> => {
      void args;
      return fakePublication('window');
    }
  );
  const setAttributes = vi.fn(async () => undefined);

  const room = {
    state: 'connected',
    localParticipant: { setScreenShareEnabled, setAttributes },
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

  return { room, rpcHandlers, setScreenShareEnabled, setAttributes };
}

function renderSession(
  room: ReturnType<typeof createFakeRoom>['room'],
  allowedSurfaces?: ShareSurface[]
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RoomContext.Provider value={room as unknown as Room}>{children}</RoomContext.Provider>
  );
  return renderHook(() => useScreenshareSession({ allowedSurfaces }), { wrapper });
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

function invokeConsent(handler: RpcHandler, payload = consentPayload()) {
  return handler({
    requestId: 'req_1',
    callerIdentity: 'agent',
    payload,
    responseTimeout: 30_000,
  });
}

async function parse(promise: Promise<string>): Promise<RequestConsentResponse> {
  return JSON.parse(await promise);
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
    const { result } = renderSession(room, ['window']);

    invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
    expect(result.current.consentRequest?.surfaces).toEqual(['window']);
  });

  it('stops the track and closes an open prompt when the agent sends screenshare.stop', async () => {
    const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
    const { result } = renderSession(room);

    const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());

    let stopRaw = '';
    await act(async () => {
      stopRaw = await rpcHandlers.get(RPC_STOP)!({
        requestId: 'req_2',
        callerIdentity: 'agent',
        payload: JSON.stringify({ v: SCREENSHARE_PROTOCOL_VERSION }),
        responseTimeout: 10_000,
      });
    });
    const stopped: StopResponse = JSON.parse(stopRaw);

    expect(stopped).toEqual({ v: SCREENSHARE_PROTOCOL_VERSION, stopped: true });
    expect(setScreenShareEnabled).toHaveBeenCalledWith(false);
    expect((await parse(rpc)).result).toBe('cancelled');
    expect(result.current.consentRequest).toBeNull();
  });

  it('clears isSharing when the browser stops the share on its own', async () => {
    const { room, rpcHandlers } = createFakeRoom();
    const { result } = renderSession(room);

    const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
    await act(async () => {
      await result.current.acceptConsent();
    });
    await rpc;
    expect(result.current.isSharing).toBe(true);

    act(() => {
      room.emit(RoomEvent.LocalTrackUnpublished, fakePublication('window'));
    });
    expect(result.current.isSharing).toBe(false);
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
