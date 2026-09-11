import type { ReactNode } from 'react';
import { Room, RoomEvent } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomContext } from '@livekit/components-react';
import { act, renderHook } from '@testing-library/react';
import {
  useScreenshareCallerConsentNotifier,
  useScreenshareStopNotifier,
} from '@/hooks/use-screenshare-peer';
import {
  AGENT_LEFT_GRACE_MS,
  type UseScreenshareSessionOptions,
  useScreenshareSession,
} from '@/hooks/use-screenshare-session';
import {
  type NotifyPayload,
  RPC_NOTIFY,
  RPC_REQUEST_CONSENT,
  RPC_STOP,
  SCREENSHARE_PROTOCOL_VERSION,
} from '@/lib/screenshare-protocol';
import {
  type FakeParticipant,
  type PerformRpcArgs,
  type RpcHandler,
  createFakeRoom,
  fakeAgent,
  stubNavigator,
} from './fake-room';

/**
 * TLZ-561 (A3). The three ways to stop must be indistinguishable to the caller and must
 * each report the right reason -- and every one of them must send exactly ONE
 * `screenshare.notify` with `event: 'stopped'`.
 *
 * That last property is the fragile one. The SDK already unpublishes the screen track
 * when the browser's own Stop sharing bar fires, so any second path that also reports a
 * stop either duplicates the notification or races the first into dropping it. This file
 * exercises the real wiring -- the session hook's `onStopped` feeding the notifier,
 * exactly as `popup-view.tsx` composes them -- rather than either half alone.
 *
 * Fake timers throughout, because `agent_left` has a grace window; `waitFor` is therefore
 * never used (testing-library only recognises jest's fake timers, and under vitest's it
 * would poll on a mocked interval that never fires).
 */

type Wired = ReturnType<typeof renderWired>;

function renderWired(
  room: ReturnType<typeof createFakeRoom>['room'],
  options: UseScreenshareSessionOptions = {}
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RoomContext.Provider value={room as unknown as Room}>{children}</RoomContext.Provider>
  );
  // Exactly the composition in popup-view.tsx: one hook reports the stop, the other
  // turns that one report into one notification.
  return renderHook(
    () => {
      const notifyStopped = useScreenshareStopNotifier();
      const notifyCallerConsent = useScreenshareCallerConsentNotifier();
      return useScreenshareSession({
        onStopped: notifyStopped,
        onCallerConsent: notifyCallerConsent,
        ...options,
      });
    },
    { wrapper }
  );
}

function consentPayload() {
  return JSON.stringify({
    v: SCREENSHARE_PROTOCOL_VERSION,
    scope: ['browser', 'window', 'monitor'],
    viewers: [{ role: 'agent' }],
    timeout_seconds: 30,
  });
}

function invokeConsent(handler: RpcHandler) {
  return handler({
    requestId: 'req_1',
    callerIdentity: 'agent-1',
    payload: consentPayload(),
    responseTimeout: 45_000,
  });
}

function invokeStop(handler: RpcHandler) {
  return handler({
    requestId: 'req_2',
    callerIdentity: 'agent-1',
    payload: JSON.stringify({ v: SCREENSHARE_PROTOCOL_VERSION }),
    responseTimeout: 10_000,
  });
}

/** Drive one agent-requested share all the way to a live screen track. */
async function shareUntilGranted(rpcHandlers: Map<string, RpcHandler>, hook: Wired) {
  const rpc = invokeConsent(rpcHandlers.get(RPC_REQUEST_CONSENT)!);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await hook.result.current.acceptConsent();
  });
  await rpc;
}

/** Every `screenshare.notify` the widget has sent, in order, decoded. */
function notifications(fake: ReturnType<typeof createFakeRoom>): NotifyPayload[] {
  return fake.performRpc.mock.calls
    .map(([params]) => params)
    .filter((params) => params.method === RPC_NOTIFY)
    .map((params) => JSON.parse(params.payload) as NotifyPayload);
}

function lastRpc(fake: ReturnType<typeof createFakeRoom>): PerformRpcArgs {
  const call = fake.performRpc.mock.calls.at(-1);
  if (!call) {
    throw new Error('no RPC was performed');
  }
  return call[0];
}

function stopNotifications(fake: ReturnType<typeof createFakeRoom>): NotifyPayload[] {
  return notifications(fake).filter((payload) => payload.event === 'stopped');
}

function consentNotifications(fake: ReturnType<typeof createFakeRoom>): NotifyPayload[] {
  return notifications(fake).filter((payload) => payload.event === 'consent');
}

function withAgent(agent: FakeParticipant = fakeAgent()) {
  const fake = createFakeRoom();
  fake.grantScreenShare();
  fake.remoteParticipants.set(agent.identity, agent);
  return { fake, agent };
}

beforeEach(() => {
  stubNavigator({ capable: true });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('one stopped notification per share', () => {
  it('reports the widget Stop button as caller_stop, once', async () => {
    const { fake } = withAgent();
    const hook = renderWired(fake.room);
    await shareUntilGranted(fake.rpcHandlers, hook);

    await act(async () => {
      await hook.result.current.stopShare('caller_stop');
    });

    expect(stopNotifications(fake)).toEqual([
      {
        v: SCREENSHARE_PROTOCOL_VERSION,
        event: 'stopped',
        initiated_by: 'caller',
        reason: 'caller_stop',
      },
    ]);
    expect(hook.result.current.isSharing).toBe(false);
  });

  it("reports the browser's own Stop sharing as browser_stop, once", async () => {
    const { fake } = withAgent();
    const hook = renderWired(fake.room);
    await shareUntilGranted(fake.rpcHandlers, hook);

    // No widget call at all on this path: the capture ends and the SDK unpublishes.
    await act(async () => {
      fake.stopFromBrowserBar();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(stopNotifications(fake)).toEqual([
      {
        v: SCREENSHARE_PROTOCOL_VERSION,
        event: 'stopped',
        initiated_by: 'caller',
        reason: 'browser_stop',
      },
    ]);
    // ...and the widget must not then unpublish a track the SDK has already taken down.
    expect(fake.setScreenShareEnabled).not.toHaveBeenCalledWith(false);
  });

  it("reports the agent's screenshare.stop as agent_end, once", async () => {
    const { fake } = withAgent();
    const hook = renderWired(fake.room);
    await shareUntilGranted(fake.rpcHandlers, hook);

    await act(async () => {
      await invokeStop(fake.rpcHandlers.get(RPC_STOP)!);
    });

    expect(stopNotifications(fake)).toEqual([
      {
        v: SCREENSHARE_PROTOCOL_VERSION,
        event: 'stopped',
        initiated_by: 'agent',
        reason: 'agent_end',
      },
    ]);
  });

  it('reports the agent leaving the room as agent_left, once', async () => {
    const { fake, agent } = withAgent();
    const hook = renderWired(fake.room);
    await shareUntilGranted(fake.rpcHandlers, hook);

    act(() => fake.removeParticipant(agent));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS);
    });

    expect(stopNotifications(fake)).toEqual([
      {
        v: SCREENSHARE_PROTOCOL_VERSION,
        event: 'stopped',
        initiated_by: 'agent',
        reason: 'agent_left',
      },
    ]);
    // The agent that has gone is still the right destination: it is the only peer that
    // was watching, and an unreachable notification is better than a silent one.
    expect(lastRpc(fake).destinationIdentity).toBe(agent.identity);
    expect(hook.result.current.isSharing).toBe(false);
  });

  it('still sends exactly one after a reconnect that outlasts the grace window', async () => {
    const { fake, agent } = withAgent();
    const hook = renderWired(fake.room);
    await shareUntilGranted(fake.rpcHandlers, hook);

    // The agent goes during a restart that takes longer than the grace window, and does
    // not come back. Nothing is reported while the room is reconnecting...
    fake.room.state = 'reconnecting';
    act(() => fake.removeParticipant(agent));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS * 4);
    });
    expect(notifications(fake)).toEqual([]);

    // ...and the departure is picked up when the connection returns, exactly once. Both
    // the expired timer and the reconnect check run against the same share.
    fake.room.state = 'connected';
    await act(async () => {
      fake.room.emit(RoomEvent.Reconnected);
      await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS * 2);
    });

    expect(stopNotifications(fake)).toEqual([
      {
        v: SCREENSHARE_PROTOCOL_VERSION,
        event: 'stopped',
        initiated_by: 'agent',
        reason: 'agent_left',
      },
    ]);
    expect(notifications(fake)).toHaveLength(1);
  });

  it('sends exactly four, one per share, across all four reasons in one session', async () => {
    const { fake, agent } = withAgent();
    const hook = renderWired(fake.room);

    await shareUntilGranted(fake.rpcHandlers, hook);
    await act(async () => {
      await hook.result.current.stopShare('caller_stop');
    });
    expect(stopNotifications(fake)).toHaveLength(1);

    await shareUntilGranted(fake.rpcHandlers, hook);
    await act(async () => {
      fake.stopFromBrowserBar();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(stopNotifications(fake)).toHaveLength(2);

    await shareUntilGranted(fake.rpcHandlers, hook);
    await act(async () => {
      await invokeStop(fake.rpcHandlers.get(RPC_STOP)!);
    });
    expect(stopNotifications(fake)).toHaveLength(3);

    await shareUntilGranted(fake.rpcHandlers, hook);
    act(() => fake.removeParticipant(agent));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS * 2);
    });

    // Four shares, four notifications, each with its own reason and none repeated.
    expect(stopNotifications(fake).map((payload) => payload.reason)).toEqual([
      'caller_stop',
      'browser_stop',
      'agent_end',
      'agent_left',
    ]);
    // Every one of them is a `stopped`; nothing else was sent down this path.
    expect(notifications(fake)).toHaveLength(4);
  });

  it('sends the version stamp and the method the agent is written against', async () => {
    const { fake } = withAgent();
    const hook = renderWired(fake.room);
    await shareUntilGranted(fake.rpcHandlers, hook);
    await act(async () => {
      await hook.result.current.stopShare('caller_stop');
    });

    const params = lastRpc(fake);
    expect(params.method).toBe(RPC_NOTIFY);
    expect(params.destinationIdentity).toBe('agent-1');
    // Bounded, so a notification can never be the thing that holds anything up.
    expect(params.responseTimeout).toBeGreaterThan(0);
    expect(stopNotifications(fake)[0].v).toBe(SCREENSHARE_PROTOCOL_VERSION);
  });
});

describe('a stop that never happened is never reported', () => {
  it('says nothing when the caller declines the prompt', async () => {
    const { fake } = withAgent();
    const hook = renderWired(fake.room);

    const rpc = invokeConsent(fake.rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => hook.result.current.declineConsent());
    await rpc;

    expect(notifications(fake)).toEqual([]);
  });

  it('says nothing when the agent withdraws while only the prompt is open', async () => {
    const { fake } = withAgent();
    const hook = renderWired(fake.room);

    const rpc = invokeConsent(fake.rpcHandlers.get(RPC_REQUEST_CONSENT)!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await invokeStop(fake.rpcHandlers.get(RPC_STOP)!);
    });
    await rpc;

    // Nothing was published, so nothing was unpublished, and no share ended.
    expect(notifications(fake)).toEqual([]);
    expect(hook.result.current.isSharing).toBe(false);
  });

  it('says nothing when a reconnect drops the agent and republishes the track', async () => {
    const { fake, agent } = withAgent();
    const hook = renderWired(fake.room);
    await shareUntilGranted(fake.rpcHandlers, hook);

    // What a full reconnect does: every remote participant disconnects, every local
    // track is unpublished and published straight back.
    act(() => fake.removeParticipant(agent));
    fake.room.state = 'reconnecting';
    await act(async () => {
      fake.stopFromBrowserBar();
      await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS);
    });
    fake.room.state = 'connected';
    act(() => fake.addParticipant(agent));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS * 2);
    });

    expect(notifications(fake)).toEqual([]);
  });

  it('does not report the session itself ending', async () => {
    const { fake } = withAgent();
    const hook = renderWired(fake.room);
    await shareUntilGranted(fake.rpcHandlers, hook);

    await act(async () => {
      fake.room.state = 'disconnected';
      fake.room.emit('disconnected');
      await vi.advanceTimersByTimeAsync(AGENT_LEFT_GRACE_MS * 2);
    });

    // There is no room left to notify, and no peer left to receive it.
    expect(notifications(fake)).toEqual([]);
    expect(hook.result.current.isSharing).toBe(false);
  });
});

describe('the notification never degrades the call', () => {
  it('swallows an RPC the agent cannot answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fake } = withAgent();
    fake.performRpc.mockRejectedValue(new Error('UNSUPPORTED_METHOD'));
    const hook = renderWired(fake.room);
    await shareUntilGranted(fake.rpcHandlers, hook);

    await act(async () => {
      // The stop itself must still succeed and still be reported to the caller.
      await expect(hook.result.current.stopShare('caller_stop')).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(hook.result.current.isSharing).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not tell the agent'),
      expect.anything()
    );
  });

  it('does not attempt an RPC when no agent was ever seen', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No agent in the room at all: the caller could not have been asked, but the browser
    // bar can still fire against a share started some other way.
    const fake = createFakeRoom();
    fake.grantScreenShare();
    const hook = renderWired(fake.room);
    await shareUntilGranted(fake.rpcHandlers, hook);

    await act(async () => {
      fake.stopFromBrowserBar();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fake.performRpc).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no agent to notify'),
      'browser_stop'
    );
    expect(hook.result.current.isSharing).toBe(false);
  });
});

describe('one consent notification per caller-started share', () => {
  it('announces the outcome of a share the caller started, once', async () => {
    const { fake, agent } = withAgent();
    const hook = renderWired(fake.room);

    await act(async () => {
      await hook.result.current.startShare();
    });

    // Exactly what the worker needs to write the audit row: who started it and what the
    // browser picker actually handed over. Without it the share is recorded as
    // "pre_existing" with an unknown surface.
    expect(consentNotifications(fake)).toEqual([
      {
        v: SCREENSHARE_PROTOCOL_VERSION,
        event: 'consent',
        initiated_by: 'caller',
        result: 'granted',
        surface: 'window',
        track_sid: 'TR_screen_1',
      },
    ]);
    expect(lastRpc(fake).method).toBe(RPC_NOTIFY);
    expect(lastRpc(fake).destinationIdentity).toBe(agent.identity);
    expect(hook.result.current.isSharing).toBe(true);
  });

  it('still sends exactly one stopped notification for that same share', async () => {
    // The regression guard for the shared sender: the two notifiers must not make the
    // stop path send twice, or differently.
    const { fake } = withAgent();
    const hook = renderWired(fake.room);

    await act(async () => {
      await hook.result.current.startShare();
    });
    await act(async () => {
      await hook.result.current.stopShare('caller_stop');
    });

    expect(stopNotifications(fake)).toEqual([
      {
        v: SCREENSHARE_PROTOCOL_VERSION,
        event: 'stopped',
        initiated_by: 'caller',
        reason: 'caller_stop',
      },
    ]);
    expect(notifications(fake)).toHaveLength(2);
  });

  it('says nothing about a share the agent asked for', async () => {
    const { fake } = withAgent();
    const hook = renderWired(fake.room);

    // The agent already knows it asked; the answer travels back on the request's own
    // RPC. A `consent` notify here would be the same fact recorded twice.
    await shareUntilGranted(fake.rpcHandlers, hook);

    expect(consentNotifications(fake)).toEqual([]);
  });

  it('swallows an announcement the agent cannot answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fake } = withAgent();
    fake.performRpc.mockRejectedValue(new Error('UNSUPPORTED_METHOD'));
    const hook = renderWired(fake.room);

    await act(async () => {
      // The share itself must still succeed: nothing here may degrade the call.
      expect((await hook.result.current.startShare()).result).toBe('granted');
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(hook.result.current.isSharing).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not tell the agent about the caller-started share'),
      expect.anything()
    );
  });
});
