import type { ReactNode } from 'react';
import { ParticipantKind, Room, RpcError, Track } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomContext } from '@livekit/components-react';
import { act, renderHook } from '@testing-library/react';
import {
  type ScreenViewerPermissionsOptions,
  computePermissions,
  useScreenViewerPermissions,
} from '@/hooks/use-screen-viewer-permissions';
import { useScreenshareSession } from '@/hooks/use-screenshare-session';
import {
  ATTR_DISPLAY_NAME,
  ATTR_ROLE,
  RPC_TAKEOVER_REQUEST_VIEWER_CONSENT,
  SCREENSHARE_PROTOCOL_VERSION,
  VIEWER_CONSENT_TIMEOUT_S,
} from '@/lib/screenshare-protocol';
import {
  type FakeRoom,
  createFakeRoom,
  fakeAgent,
  fakeHuman,
  fakeSip,
  fakeStaff,
  stubNavigator,
} from './fake-room';

const MIC = { trackSid: 'TR_mic', source: Track.Source.Microphone };
const SCREEN = { trackSid: 'TR_scr', source: Track.Source.ScreenShare };
const agent = { identity: 'agent-1', kind: ParticipantKind.AGENT, attributes: {} };
const sip = { identity: 'human-agent-sip', kind: ParticipantKind.SIP, attributes: {} };
const rep = {
  identity: 'rep-1',
  kind: ParticipantKind.STANDARD,
  attributes: { [ATTR_ROLE]: 'rep' },
};

describe('computePermissions (spec §6)', () => {
  it('no screen published: exactly today’s behaviour, staff or not', () => {
    expect(
      computePermissions({
        remotes: [agent, sip, rep],
        localTracks: [MIC],
        grantedIdentities: new Set(['rep-1']),
        screenSid: null,
      })
    ).toEqual({ allParticipantsAllowed: true, trackPermissions: [] });
  });

  it('share live, no staff: still restricted, agent and SIP get everything (R19)', () => {
    expect(
      computePermissions({
        remotes: [agent, sip],
        localTracks: [MIC, SCREEN],
        grantedIdentities: new Set(),
        screenSid: 'TR_scr',
      })
    ).toEqual({
      allParticipantsAllowed: false,
      trackPermissions: [
        { participantIdentity: 'agent-1', allowAll: true },
        { participantIdentity: 'human-agent-sip', allowAll: true },
      ],
    });
  });

  it('staff present, not granted: staff hears the caller only; agent and SIP get everything', () => {
    expect(
      computePermissions({
        remotes: [agent, sip, rep],
        localTracks: [MIC, SCREEN],
        grantedIdentities: new Set(),
        screenSid: 'TR_scr',
      })
    ).toEqual({
      allParticipantsAllowed: false,
      trackPermissions: [
        { participantIdentity: 'agent-1', allowAll: true },
        { participantIdentity: 'human-agent-sip', allowAll: true },
        { participantIdentity: 'rep-1', allowedTrackSids: ['TR_mic'] },
      ],
    });
  });

  it('granted staff also gets the screen; an ungranted observer does not', () => {
    const observer = { ...rep, identity: 'obs-1', attributes: { [ATTR_ROLE]: 'observer' } };
    const { trackPermissions } = computePermissions({
      remotes: [rep, observer],
      localTracks: [MIC, SCREEN],
      grantedIdentities: new Set(['rep-1']),
      screenSid: 'TR_scr',
    });
    expect(trackPermissions).toEqual([
      { participantIdentity: 'rep-1', allowedTrackSids: ['TR_mic', 'TR_scr'] },
      { participantIdentity: 'obs-1', allowedTrackSids: ['TR_mic'] },
    ]);
  });

  it('a STANDARD participant with an unknown role, or a role on a non-browser kind, is not staff', () => {
    const odd = { ...rep, identity: 'x', attributes: { [ATTR_ROLE]: 'admin' } };
    const sipWithRole = { ...sip, attributes: { [ATTR_ROLE]: 'rep' } };
    expect(
      computePermissions({
        remotes: [odd, sipWithRole],
        localTracks: [MIC, SCREEN],
        grantedIdentities: new Set(),
        screenSid: 'TR_scr',
      }).trackPermissions
    ).toEqual([
      { participantIdentity: 'x', allowAll: true },
      { participantIdentity: 'human-agent-sip', allowAll: true },
    ]);
  });
});

function renderViewer(room: FakeRoom, options: ScreenViewerPermissionsOptions = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RoomContext.Provider value={room as unknown as Room}>{children}</RoomContext.Provider>
  );
  return renderHook(() => useScreenViewerPermissions(options), { wrapper });
}

function request(identity = 'rep-1', name = 'Dana') {
  return {
    requestId: 'r1',
    callerIdentity: 'agent-1',
    payload: JSON.stringify({
      v: SCREENSHARE_PROTOCOL_VERSION,
      viewer: { identity, name, role: 'rep' },
    }),
    responseTimeout: 45_000,
  };
}

/** The AI agent is in the room: only it may ask for viewer consent. */
function roomWithAgent() {
  const fake = createFakeRoom();
  fake.addParticipant(fakeAgent('agent-1'));
  return fake;
}

const lastCall = (fake: ReturnType<typeof createFakeRoom>) =>
  fake.setTrackSubscriptionPermissions.mock.calls.at(-1);

describe('useScreenViewerPermissions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies (true, []) on mount and on every participant connect/disconnect with no share', () => {
    const fake = createFakeRoom();
    renderViewer(fake.room);
    expect(fake.setTrackSubscriptionPermissions).toHaveBeenCalledTimes(1);
    expect(lastCall(fake)).toEqual([true, []]);

    act(() => fake.addParticipant(fakeAgent()));
    act(() => fake.addParticipant(fakeSip()));
    const staff = fakeStaff();
    act(() => fake.addParticipant(staff));
    act(() => fake.removeParticipant(staff));
    expect(fake.setTrackSubscriptionPermissions).toHaveBeenCalledTimes(5);
    fake.setTrackSubscriptionPermissions.mock.calls.forEach((call) =>
      expect(call).toEqual([true, []])
    );
  });

  it('restricts from the moment the screen is published until it is unpublished', () => {
    const fake = createFakeRoom();
    fake.publishMic('TR_mic');
    act(() => fake.addParticipant(fakeAgent()));
    renderViewer(fake.room);
    expect(lastCall(fake)).toEqual([true, []]);

    act(() => {
      fake.publishScreen('TR_scr_1');
    });
    expect(lastCall(fake)).toEqual([false, [{ participantIdentity: 'agent-1', allowAll: true }]]);

    act(() => fake.stopFromBrowserBar());
    expect(lastCall(fake)).toEqual([true, []]);
  });

  it('staff joining mid-share is never in an allowAll entry and never gets the screen', () => {
    const fake = createFakeRoom();
    fake.publishMic('TR_mic');
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(fakeAgent()));
    renderViewer(fake.room);

    act(() => fake.addParticipant(fakeStaff('rep-1')));
    expect(lastCall(fake)).toEqual([
      false,
      [
        { participantIdentity: 'agent-1', allowAll: true },
        { participantIdentity: 'rep-1', allowedTrackSids: ['TR_mic'] },
      ],
    ]);
    fake.setTrackSubscriptionPermissions.mock.calls.forEach(([all, perms]) => {
      expect(all).toBe(false);
      expect(perms).not.toContainEqual(
        expect.objectContaining({ participantIdentity: 'rep-1', allowAll: true })
      );
    });
  });

  it('recomputes when a participant role attribute arrives after connect', () => {
    const fake = createFakeRoom();
    fake.publishScreen('TR_scr_1');
    renderViewer(fake.room);
    const late = fakeHuman('rep-2');
    act(() => fake.addParticipant(late));
    expect(lastCall(fake)?.[1]).toEqual([{ participantIdentity: 'rep-2', allowAll: true }]);
    act(() => fake.setParticipantAttributes(late, { [ATTR_ROLE]: 'observer' }));
    expect(lastCall(fake)?.[1]).toEqual([{ participantIdentity: 'rep-2', allowedTrackSids: [] }]);
  });

  it('fails closed: a throw while a screen is live stops the share; with no screen it does not', () => {
    const fake = createFakeRoom();
    const onFailClosed = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderViewer(fake.room, { onFailClosed });
    fake.setTrackSubscriptionPermissions.mockImplementation(() => {
      throw new Error('signal down');
    });
    act(() => fake.addParticipant(fakeAgent()));
    expect(onFailClosed).not.toHaveBeenCalled();
    act(() => {
      fake.publishScreen('TR_scr_1');
    });
    expect(onFailClosed).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('a granted staff member who leaves and rejoins mid-share must be asked again', async () => {
    const fake = roomWithAgent();
    fake.publishMic('TR_mic');
    fake.publishScreen('TR_scr_1');
    const staff = fakeStaff('rep-1');
    act(() => fake.addParticipant(staff));
    const { result } = renderViewer(fake.room);
    let pending!: Promise<string>;
    act(() => {
      pending = result.current.handleViewerConsent(request());
    });
    act(() => result.current.allowViewer());
    await pending;
    expect(lastCall(fake)?.[1]).toContainEqual({
      participantIdentity: 'rep-1',
      allowedTrackSids: ['TR_mic', 'TR_scr_1'],
    });

    act(() => fake.removeParticipant(staff));
    act(() => fake.addParticipant(fakeStaff('rep-1')));
    expect(lastCall(fake)?.[1]).toContainEqual({
      participantIdentity: 'rep-1',
      allowedTrackSids: ['TR_mic'],
    });
  });

  it('no live share: answers no_share immediately, no prompt', async () => {
    const fake = roomWithAgent();
    act(() => fake.addParticipant(fakeStaff('rep-1')));
    const { result } = renderViewer(fake.room);
    const answer = await result.current.handleViewerConsent(request());
    expect(JSON.parse(answer)).toEqual({ v: SCREENSHARE_PROTOCOL_VERSION, outcome: 'no_share' });
    expect(result.current.viewerConsentRequest).toBeNull();
  });

  it('a malformed request is refused, not prompted', async () => {
    const fake = roomWithAgent();
    fake.publishScreen();
    const { result } = renderViewer(fake.room);
    await expect(
      result.current.handleViewerConsent({ ...request(), payload: '{"v":1,"viewer":{}}' })
    ).rejects.toBeInstanceOf(RpcError);
    expect(result.current.viewerConsentRequest).toBeNull();
  });

  it('allow: prompt shows the participant’s display name, grant opens the screen to that person only', async () => {
    const fake = roomWithAgent();
    fake.publishMic('TR_mic');
    fake.publishScreen('TR_scr_1');
    const staff = fakeStaff('rep-1');
    staff.attributes[ATTR_DISPLAY_NAME] = 'Dana from Support';
    act(() => fake.addParticipant(staff));
    act(() => fake.addParticipant(fakeStaff('obs-1', 'observer')));
    const { result } = renderViewer(fake.room);

    let pending!: Promise<string>;
    act(() => {
      pending = result.current.handleViewerConsent(request('rep-1', 'Dana'));
    });
    expect(result.current.viewerConsentRequest).toMatchObject({
      identity: 'rep-1',
      name: 'Dana from Support',
      role: 'rep',
      timeoutSeconds: VIEWER_CONSENT_TIMEOUT_S,
    });

    act(() => result.current.allowViewer());
    expect(JSON.parse(await pending)).toEqual({ v: 1, outcome: 'granted' });
    expect(result.current.viewerConsentRequest).toBeNull();
    expect(lastCall(fake)).toEqual([
      false,
      [
        { participantIdentity: 'agent-1', allowAll: true },
        { participantIdentity: 'rep-1', allowedTrackSids: ['TR_mic', 'TR_scr_1'] },
        { participantIdentity: 'obs-1', allowedTrackSids: ['TR_mic'] },
      ],
    ]);
  });

  it('a new share (new screen sid) clears every grant', async () => {
    const fake = roomWithAgent();
    fake.publishMic('TR_mic');
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(fakeStaff('rep-1')));
    const { result } = renderViewer(fake.room);

    let pending!: Promise<string>;
    act(() => {
      pending = result.current.handleViewerConsent(request());
    });
    act(() => result.current.allowViewer());
    await pending;
    expect(lastCall(fake)?.[1]).toContainEqual({
      participantIdentity: 'rep-1',
      allowedTrackSids: ['TR_mic', 'TR_scr_1'],
    });

    act(() => fake.stopFromBrowserBar());
    act(() => {
      fake.publishScreen('TR_scr_2');
    });
    expect(lastCall(fake)?.[1]).toContainEqual({
      participantIdentity: 'rep-1',
      allowedTrackSids: ['TR_mic'],
    });
  });

  it('don’t allow answers declined and opens nothing', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(fakeStaff('rep-1')));
    const { result } = renderViewer(fake.room);
    let pending!: Promise<string>;
    act(() => {
      pending = result.current.handleViewerConsent(request());
    });
    act(() => result.current.denyViewer());
    expect(JSON.parse(await pending).outcome).toBe('declined');
    expect(lastCall(fake)?.[1]).toContainEqual({
      participantIdentity: 'rep-1',
      allowedTrackSids: [],
    });
  });

  it('times out after 30 s with `timeout`', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(fakeStaff('rep-1')));
    const { result } = renderViewer(fake.room);
    let pending!: Promise<string>;
    act(() => {
      pending = result.current.handleViewerConsent(request());
    });
    act(() => vi.advanceTimersByTime(VIEWER_CONSENT_TIMEOUT_S * 1000 - 1));
    expect(result.current.viewerConsentRequest).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(JSON.parse(await pending).outcome).toBe('timeout');
    expect(result.current.viewerConsentRequest).toBeNull();
  });

  it('the share ending while the prompt is open answers no_share', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(fakeStaff('rep-1')));
    const { result } = renderViewer(fake.room);
    let pending!: Promise<string>;
    act(() => {
      pending = result.current.handleViewerConsent(request());
    });
    act(() => fake.stopFromBrowserBar());
    expect(JSON.parse(await pending).outcome).toBe('no_share');
    expect(result.current.viewerConsentRequest).toBeNull();
  });

  it('a request from anyone but the AI agent is declined, unprompted, and grants nothing', async () => {
    const fake = roomWithAgent();
    fake.publishMic('TR_mic');
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(fakeStaff('rep-1')));
    const { result } = renderViewer(fake.room);
    for (const callerIdentity of ['rep-1', 'nobody-here']) {
      const answer = await result.current.handleViewerConsent({ ...request(), callerIdentity });
      expect(JSON.parse(answer)).toEqual({ v: 1, outcome: 'declined' });
    }
    expect(result.current.viewerConsentRequest).toBeNull();
    act(() => result.current.allowViewer());
    expect(lastCall(fake)?.[1]).toContainEqual({
      participantIdentity: 'rep-1',
      allowedTrackSids: ['TR_mic'],
    });
  });

  it('a viewer who is not a staff member in the room is declined, unprompted', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(fakeHuman('plain-1')));
    act(() => fake.addParticipant(fakeSip()));
    const { result } = renderViewer(fake.room);
    for (const identity of ['absent-rep', 'plain-1', 'human-agent-sip']) {
      const answer = await result.current.handleViewerConsent(request(identity));
      expect(JSON.parse(answer).outcome).toBe('declined');
    }
    expect(result.current.viewerConsentRequest).toBeNull();
  });

  it('two requests queue: the second is shown after the first is answered', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(fakeStaff('rep-1')));
    act(() => fake.addParticipant(fakeStaff('obs-1', 'observer')));
    const { result } = renderViewer(fake.room);
    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => {
      first = result.current.handleViewerConsent(request('rep-1', 'Dana'));
      second = result.current.handleViewerConsent(request('obs-1', 'Sam'));
    });
    expect(result.current.viewerConsentRequest?.identity).toBe('rep-1');
    act(() => result.current.denyViewer());
    expect(result.current.viewerConsentRequest?.identity).toBe('obs-1');
    act(() => result.current.allowViewer());
    expect(JSON.parse(await first).outcome).toBe('declined');
    expect(JSON.parse(await second).outcome).toBe('granted');
  });
});

describe('useScreenshareSession wiring', () => {
  it('registers takeover.requestViewerConsent and unregisters it on unmount', () => {
    stubNavigator({ capable: true });
    const fake = createFakeRoom();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RoomContext.Provider value={fake.room as unknown as Room}>{children}</RoomContext.Provider>
    );
    const { unmount } = renderHook(() => useScreenshareSession(), { wrapper });
    expect(fake.rpcHandlers.has(RPC_TAKEOVER_REQUEST_VIEWER_CONSENT)).toBe(true);
    unmount();
    expect(fake.rpcHandlers.has(RPC_TAKEOVER_REQUEST_VIEWER_CONSENT)).toBe(false);
    vi.unstubAllGlobals();
  });

  it('fails closed: a permissions throw during a live share takes the screen down', async () => {
    stubNavigator({ capable: true });
    const fake = createFakeRoom();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RoomContext.Provider value={fake.room as unknown as Room}>{children}</RoomContext.Provider>
    );
    renderHook(() => useScreenshareSession(), { wrapper });
    fake.setTrackSubscriptionPermissions.mockImplementation(() => {
      throw new Error('signal down');
    });
    await act(async () => {
      fake.publishScreen('TR_scr_1');
    });
    expect(fake.setScreenShareEnabled).toHaveBeenCalledWith(false);
    expect(fake.getTrackPublication()).toBeUndefined();
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
