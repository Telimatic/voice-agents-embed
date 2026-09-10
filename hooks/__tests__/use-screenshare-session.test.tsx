import type { ReactNode } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomContext } from '@livekit/components-react';
// eslint-plugin-import cannot follow @testing-library/react's export map; `waitFor`
// is exported and resolves at runtime.
// eslint-disable-next-line import/named
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  AGENT_LEFT_GRACE_MS,
  MAX_CONSENT_TIMEOUT_SECONDS,
  type UseScreenshareSessionOptions,
  useScreenshareSession,
} from '@/hooks/use-screenshare-session';
import {
  ATTR_ALLOWED_SURFACES,
  ATTR_ENABLED,
  RPC_REQUEST_CONSENT,
  RPC_STOP,
  type RequestConsentResponse,
  SCREENSHARE_PROTOCOL_VERSION,
  type ShareSurface,
  type StopReason,
  type StopResponse,
} from '@/lib/screenshare-protocol';
import {
  type FakeRoom,
  type RpcHandler,
  createFakeRoom,
  fakeAgent,
  fakeHuman,
  fakePublication,
  holdPicker,
  stubNavigator,
} from './fake-room';

function renderSession(room: FakeRoom, options: UseScreenshareSessionOptions = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RoomContext.Provider value={room as unknown as Room}>{children}</RoomContext.Provider>
  );
  // The worker has widened the permission unless a test says otherwise.
  return renderHook(() => useScreenshareSession(options), { wrapper });
}

/** A room whose caller may already publish a screen: the common case in this file. */
function createGrantedRoom() {
  const fake = createFakeRoom();
  fake.grantScreenShare();
  return fake;
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

/**
 * The same thing under fake timers. `waitFor` cannot be used there -- testing-library
 * only recognises jest's fake timers, so under vitest's it polls with a mocked interval
 * that never fires -- so the render is flushed by advancing the clock instead.
 */
async function shareUntilGrantedWithFakeTimers(
  rpcHandlers: Map<string, RpcHandler>,
  hook: ReturnType<typeof renderSession>
) {
  const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
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

  it('registers both RPC methods on connect', async () => {
    const { room, rpcHandlers } = createGrantedRoom();
    renderSession(room);

    await waitFor(() => expect(rpcHandlers.has(RPC_REQUEST_CONSENT)).toBe(true));
    expect(rpcHandlers.has(RPC_STOP)).toBe(true);
  });

  it('never writes a participant attribute, because the token grants no permission to', async () => {
    // ATTR_CAPABLE is stamped into the access token server-side
    // (app/api/connection-details/route.ts). Publishing it from here required
    // `canUpdateOwnMetadata` on a public CORS-`*` token route, and LiveKit filters no
    // attribute keys — so that permission also let a tampered page write the `caller` /
    // `sip.*` keys the worker reads as caller identity. If this assertion ever fails, the
    // grant has to come back, and the spoofing path comes back with it.
    const { room, rpcHandlers, setAttributes } = createGrantedRoom();
    renderSession(room);

    await waitFor(() => expect(rpcHandlers.has(RPC_REQUEST_CONSENT)).toBe(true));
    expect(setAttributes).not.toHaveBeenCalled();
  });

  it('answers granted with the surface actually chosen and the track sid, only after publish', async () => {
    const { room, rpcHandlers, setScreenShareEnabled } = createGrantedRoom();
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
    const { room, rpcHandlers, setScreenShareEnabled } = createGrantedRoom();
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
    const { room, rpcHandlers, setScreenShareEnabled } = createGrantedRoom();
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
    const { room, rpcHandlers, setScreenShareEnabled } = createGrantedRoom();
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
    const { room, rpcHandlers, setScreenShareEnabled } = createGrantedRoom();
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
    const { room, rpcHandlers, setScreenShareEnabled } = createGrantedRoom();
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
      const { room, rpcHandlers, setScreenShareEnabled } = createGrantedRoom();
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
    const { room, rpcHandlers, setScreenShareEnabled, setAttributes } = createGrantedRoom();
    const { result } = renderSession(room);

    // The capability now rides the token, so an incapable browser refuses at the RPC
    // rather than by having advertised `capable: false` beforehand.
    await waitFor(() => expect(rpcHandlers.has(RPC_REQUEST_CONSENT)).toBe(true));
    expect(setAttributes).not.toHaveBeenCalled();

    const response = await parse(invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!));
    expect(response.result).toBe('unsupported');
    expect(setScreenShareEnabled).not.toHaveBeenCalled();
    expect(result.current.consentRequest).toBeNull();
  });

  it('never prompts before the worker has widened the permission', async () => {
    const { room, rpcHandlers, setScreenShareEnabled } = createFakeRoom();
    const { result } = renderSession(room);

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

  it('honours a request once the permission arrives, and refuses again if it is revoked', async () => {
    stubNavigator({ capable: true });
    const fake = createFakeRoom();
    fake.addParticipant(fakeAgent());
    const { result } = renderSession(fake.room);
    await waitFor(() => expect(fake.rpcHandlers.has(RPC_REQUEST_CONSENT)).toBe(true));
    expect(result.current.canShare).toBe(false);

    act(() => fake.grantScreenShare());
    await waitFor(() => expect(result.current.canShare).toBe(true));
    const rpc = invokeConsent(fake.rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
    act(() => result.current.declineConsent());
    expect((await parse(rpc)).result).toBe('declined');

    act(() => fake.revokeScreenShare());
    await waitFor(() => expect(result.current.canShare).toBe(false));
    const refused = await parse(invokeConsent(fake.rpcHandlers.get(RPC_REQUEST_CONSENT)!));
    expect(refused).toMatchObject({ result: 'failed', reason: 'not_permitted' });
    expect(fake.setScreenShareEnabled).not.toHaveBeenCalled();
  });

  it('startShare refuses before the permission and works after', async () => {
    stubNavigator({ capable: true });
    const fake = createFakeRoom();
    fake.addParticipant(fakeAgent());
    const { result } = renderSession(fake.room);
    await waitFor(() => expect(fake.rpcHandlers.has(RPC_REQUEST_CONSENT)).toBe(true));
    let response = await act(() => result.current.startShare());
    expect(response).toMatchObject({ result: 'failed', reason: 'not_permitted' });
    act(() => fake.grantScreenShare());
    await waitFor(() => expect(result.current.canShare).toBe(true));
    response = await act(() => result.current.startShare());
    expect(response.result).toBe('granted');
  });

  it('refuses a request stamped with a different protocol version', async () => {
    const { room, rpcHandlers, setScreenShareEnabled } = createGrantedRoom();
    renderSession(room);

    const response = await parse(
      invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!, consentPayload({ v: 99 }))
    );
    expect(response.result).toBe('failed');
    expect(response.reason).toBe('protocol_version_mismatch');
    expect(setScreenShareEnabled).not.toHaveBeenCalled();
  });

  it('narrows the offered surfaces to what policy allows', async () => {
    const fake = createGrantedRoom();
    const surfaces: ShareSurface[] = ['window'];
    fake.addParticipant(
      fakeAgent('agent-1', {
        [ATTR_ENABLED]: 'true',
        [ATTR_ALLOWED_SURFACES]: surfaces.join(','),
      })
    );
    const { result } = renderSession(fake.room);

    invokeConsent(fake.rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
    expect(result.current.consentRequest?.surfaces).toEqual(['window']);
  });

  describe('the prompt window', () => {
    it('never outlives the response timeout the agent is listening on', async () => {
      const { room, rpcHandlers } = createGrantedRoom();
      const { result } = renderSession(room);

      // LiveKit's default responseTimeout is 10s; a 30s prompt would answer into the void.
      invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!, consentPayload(), 10_000);
      await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
      expect(result.current.consentRequest?.timeoutSeconds).toBe(9);
    });

    it('bounds a timeout_seconds the peer sends rather than trusting it', async () => {
      const { room, rpcHandlers } = createGrantedRoom();
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
      const { room, rpcHandlers } = createGrantedRoom();
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
      const { room, rpcHandlers, setScreenShareEnabled } = createGrantedRoom();
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
      const { room, rpcHandlers, setScreenShareEnabled } = createGrantedRoom();
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
      const { room, rpcHandlers, setScreenShareEnabled } = createGrantedRoom();
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
      const { room, rpcHandlers, setScreenShareEnabled } = createGrantedRoom();
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
      const fake = createGrantedRoom();
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
      const fake = createGrantedRoom();
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
      const fake = createGrantedRoom();
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
      const fake = createGrantedRoom();
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
      const fake = createGrantedRoom();
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
      const { room, rpcHandlers } = createGrantedRoom();
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
      const { room, rpcHandlers } = createGrantedRoom();
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
      const { room, rpcHandlers } = createGrantedRoom();
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

  describe('the share control is gated on an agent that can receive the share', () => {
    it('offers nothing until such an agent is in the room', async () => {
      const fake = createGrantedRoom();
      const hook = renderSession(fake.room);

      // The token said yes and the browser can capture, but nobody is listening.
      expect(hook.result.current.agentReady).toBe(false);
      expect(hook.result.current.canShare).toBe(false);

      act(() => fake.addParticipant(fakeAgent()));
      await waitFor(() => expect(hook.result.current.canShare).toBe(true));
    });

    it('sees the attribute the agent publishes AFTER it joins', async () => {
      const fake = createGrantedRoom();
      const hook = renderSession(fake.room);

      // This is the real sequence: the worker joins, resolves the session, and only then
      // sets the attribute. A ParticipantConnected-only listener never sees it.
      const agent = fakeAgent('agent-1', { [ATTR_ENABLED]: 'false' });
      act(() => fake.addParticipant(agent));
      expect(hook.result.current.canShare).toBe(false);

      act(() => fake.setParticipantAttributes(agent, { [ATTR_ENABLED]: 'true' }));
      await waitFor(() => expect(hook.result.current.canShare).toBe(true));
    });

    it('withdraws the control when that agent leaves', async () => {
      const fake = createGrantedRoom();
      const agent = fakeAgent();
      const hook = renderSession(fake.room);
      act(() => fake.addParticipant(agent));
      await waitFor(() => expect(hook.result.current.canShare).toBe(true));

      act(() => fake.removeParticipant(agent));
      await waitFor(() => expect(hook.result.current.canShare).toBe(false));
    });

    it('ignores a human participant and an agent that never enabled screenshare', async () => {
      const fake = createGrantedRoom();
      const hook = renderSession(fake.room);

      act(() => fake.addParticipant(fakeHuman()));
      act(() => fake.addParticipant(fakeAgent('agent-off', {})));
      // Two participants, neither of which can receive a share.
      await waitFor(() => expect(fake.room.remoteParticipants.size).toBe(2));
      expect(hook.result.current.canShare).toBe(false);
    });

    it('stays shut for an organization the token did not grant, and for a device that cannot capture', async () => {
      const denied = createFakeRoom();
      const deniedHook = renderSession(denied.room);
      act(() => denied.addParticipant(fakeAgent()));
      await waitFor(() => expect(deniedHook.result.current.agentReady).toBe(true));
      expect(deniedHook.result.current.canShare).toBe(false);

      stubNavigator({ capable: false });
      const incapable = createFakeRoom();
      const incapableHook = renderSession(incapable.room);
      act(() => incapable.addParticipant(fakeAgent()));
      await waitFor(() => expect(incapableHook.result.current.agentReady).toBe(true));
      expect(incapableHook.result.current.canShare).toBe(false);
    });
  });

  describe('agent_left', () => {
    it('ends the share, once, when the agent goes', async () => {
      vi.useFakeTimers();
      try {
        const reasons: StopReason[] = [];
        const fake = createGrantedRoom();
        const agent = fakeAgent();
        fake.remoteParticipants.set(agent.identity, agent);
        const hook = renderSession(fake.room, { onStopped: (reason) => reasons.push(reason) });
        await shareUntilGrantedWithFakeTimers(fake.rpcHandlers, hook);
        expect(hook.result.current.isSharing).toBe(true);

        act(() => fake.removeParticipant(agent));
        // Nothing yet: the grace window is exactly what stops a reconnect blip from
        // reading as a departure.
        expect(reasons).toEqual([]);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS);
        });

        // One notification, from the same single unpublish listener as every other stop.
        expect(reasons).toEqual(['agent_left']);
        expect(fake.setScreenShareEnabled).toHaveBeenLastCalledWith(false);
        expect(hook.result.current.isSharing).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports nothing when there was no share to end', async () => {
      vi.useFakeTimers();
      try {
        const reasons: StopReason[] = [];
        const fake = createGrantedRoom();
        const agent = fakeAgent();
        fake.remoteParticipants.set(agent.identity, agent);
        renderSession(fake.room, { onStopped: (reason) => reasons.push(reason) });

        act(() => fake.removeParticipant(agent));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS);
        });

        expect(reasons).toEqual([]);
        expect(fake.setScreenShareEnabled).not.toHaveBeenCalledWith(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('survives a reconnect that drops the agent and brings it straight back', async () => {
      vi.useFakeTimers();
      try {
        const reasons: StopReason[] = [];
        const fake = createGrantedRoom();
        const agent = fakeAgent();
        fake.remoteParticipants.set(agent.identity, agent);
        const hook = renderSession(fake.room, { onStopped: (reason) => reasons.push(reason) });
        await shareUntilGrantedWithFakeTimers(fake.rpcHandlers, hook);

        // A full reconnect disconnects every remote participant and restores them.
        act(() => fake.removeParticipant(agent));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS / 3);
        });
        act(() => fake.addParticipant(agent));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS * 2);
        });

        // The caller's screen was never torn down over a network blip.
        expect(reasons).toEqual([]);
        expect(hook.result.current.isSharing).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('still reports the departure after a reconnect longer than the grace window', async () => {
      vi.useFakeTimers();
      try {
        const reasons: StopReason[] = [];
        const fake = createGrantedRoom();
        const agent = fakeAgent();
        fake.remoteParticipants.set(agent.identity, agent);
        const hook = renderSession(fake.room, { onStopped: (reason) => reasons.push(reason) });
        await shareUntilGrantedWithFakeTimers(fake.rpcHandlers, hook);

        // A restart drops every remote participant, and this one takes longer than the
        // grace window. The timer fires mid-restart, correctly declines to report, and
        // nulls itself -- and the SDK will not emit ParticipantDisconnected again.
        fake.room.state = 'reconnecting';
        act(() => fake.removeParticipant(agent));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS * 4);
        });
        expect(reasons).toEqual([]);

        // ...so the departure has to be picked up when the connection comes back. By then
        // the SDK has already set the state and repopulated remoteParticipants.
        fake.room.state = 'connected';
        await act(async () => {
          fake.room.emit(RoomEvent.Reconnected);
          await vi.advanceTimersByTimeAsync(0);
        });

        expect(reasons).toEqual(['agent_left']);
        expect(hook.result.current.isSharing).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports nothing on reconnect when the agent came back', async () => {
      vi.useFakeTimers();
      try {
        const reasons: StopReason[] = [];
        const fake = createGrantedRoom();
        const agent = fakeAgent();
        fake.remoteParticipants.set(agent.identity, agent);
        const hook = renderSession(fake.room, { onStopped: (reason) => reasons.push(reason) });
        await shareUntilGrantedWithFakeTimers(fake.rpcHandlers, hook);

        fake.room.state = 'reconnecting';
        act(() => fake.removeParticipant(agent));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS * 4);
        });

        // The SDK repopulates remoteParticipants from the join response BEFORE it emits
        // Reconnected, so a returning agent is already visible here.
        fake.remoteParticipants.set(agent.identity, agent);
        fake.room.state = 'connected';
        await act(async () => {
          fake.room.emit(RoomEvent.Reconnected);
          await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS * 2);
        });

        expect(reasons).toEqual([]);
        expect(hook.result.current.isSharing).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports the departure once when the grace timer and the reconnect both land', async () => {
      vi.useFakeTimers();
      try {
        const reasons: StopReason[] = [];
        const fake = createGrantedRoom();
        const agent = fakeAgent();
        fake.remoteParticipants.set(agent.identity, agent);
        const hook = renderSession(fake.room, { onStopped: (reason) => reasons.push(reason) });
        await shareUntilGrantedWithFakeTimers(fake.rpcHandlers, hook);

        // Both paths armed at once, with the room connected throughout, so neither is
        // filtered out by a state check. Exactly one stop must still be reported.
        act(() => fake.removeParticipant(agent));
        await act(async () => {
          fake.room.emit(RoomEvent.Reconnected);
          await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS * 4);
        });

        expect(reasons).toEqual(['agent_left']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('starts no second teardown while the first is still in flight', async () => {
      vi.useFakeTimers();
      try {
        const reasons: StopReason[] = [];
        const fake = createGrantedRoom();
        const agent = fakeAgent();
        fake.remoteParticipants.set(agent.identity, agent);
        const hook = renderSession(fake.room, { onStopped: (reason) => reasons.push(reason) });
        await shareUntilGrantedWithFakeTimers(fake.rpcHandlers, hook);
        const stopsBefore = fake.setScreenShareEnabled.mock.calls.filter(([on]) => !on).length;

        // The real SDK unpublishes asynchronously, so there is a window in which the
        // track is still published AND a stop is already under way. Held open here.
        let release!: () => void;
        fake.setScreenShareEnabled.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () => {
                fake.stopFromBrowserBar();
                resolve(undefined);
              };
            })
        );

        act(() => fake.removeParticipant(agent));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS);
        });
        // The reconnect check lands inside that window, sees a live publication, and must
        // still decline: a stop is already on its way.
        await act(async () => {
          fake.room.emit(RoomEvent.Reconnected);
          await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => {
          release();
          await vi.advanceTimersByTimeAsync(0);
        });

        const stopsAfter = fake.setScreenShareEnabled.mock.calls.filter(([on]) => !on).length;
        expect(stopsAfter - stopsBefore).toBe(1);
        expect(reasons).toEqual(['agent_left']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not read a reconnect republish as a stop', async () => {
      const reasons: StopReason[] = [];
      const fake = createGrantedRoom();
      const hook = renderSession(fake.room, { onStopped: (reason) => reasons.push(reason) });
      await shareUntilGranted(fake.rpcHandlers, hook);

      // republishAllTracks unpublishes every local track and publishes it straight back.
      // Reported, that would be a stop for a share that is still live -- and then a
      // SECOND stop when it really ends.
      fake.room.state = 'reconnecting';
      act(() => {
        fake.room.emit(RoomEvent.LocalTrackUnpublished, fakePublication('window'));
      });
      expect(reasons).toEqual([]);

      fake.room.state = 'connected';
      act(() => {
        fake.room.emit(RoomEvent.LocalTrackUnpublished, fakePublication('window'));
      });
      expect(reasons).toEqual(['browser_stop']);
    });
  });

  it('answers an outstanding request rather than dangling when the widget closes', async () => {
    const { room, rpcHandlers } = createGrantedRoom();
    const { result, unmount } = renderSession(room);

    const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await waitFor(() => expect(result.current.consentRequest).not.toBeNull());
    unmount();

    const response = await parse(rpc);
    expect(response.result).toBe('failed');
    expect(response.reason).toBe('widget_closed');
  });
});
