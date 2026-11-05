import type { ReactNode } from 'react';
import { ParticipantKind, Room, RoomEvent, RpcError, Track } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomContext } from '@livekit/components-react';
// eslint-disable-next-line import/named
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  type ScreenViewerPermissions,
  type ScreenViewerPermissionsOptions,
  VIEWER_CONSENT_CLICK_GUARD_MS,
  computePermissions,
  useScreenViewerPermissions,
} from '@/hooks/use-screen-viewer-permissions';
import { useScreenshareSession } from '@/hooks/use-screenshare-session';
import {
  ATTR_DISPLAY_NAME,
  ATTR_ROLE,
  RPC_REQUEST_CONSENT,
  RPC_TAKEOVER_REQUEST_VIEWER_CONSENT,
  SCREENSHARE_PROTOCOL_VERSION,
  VIEWER_CONSENT_TIMEOUT_S,
} from '@/lib/screenshare-protocol';
import {
  type FakeRoom,
  createFakeRoom,
  fakeAgent,
  fakeHuman,
  fakePublication,
  fakeSip,
  holdPicker,
  staffParticipant,
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
  it('no screen, no staff: exactly today’s behaviour', () => {
    expect(
      computePermissions({
        remotes: [agent, sip],
        localTracks: [MIC, { trackSid: 'TR_cam', source: Track.Source.Camera }],
        grantedIdentities: new Set(),
        screenSid: null,
      })
    ).toEqual({ allParticipantsAllowed: true, trackPermissions: [] });
  });

  it('no screen, camera on, staff present: staff get the microphone only (R22)', () => {
    expect(
      computePermissions({
        remotes: [agent, sip, rep],
        localTracks: [MIC, { trackSid: 'TR_cam', source: Track.Source.Camera }],
        grantedIdentities: new Set(['rep-1']),
        screenSid: null,
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

  it('a role without the staff identity prefix is still restricted (fail closed)', () => {
    const forged = { ...rep, identity: 'embed_user_1' };
    expect(
      computePermissions({
        remotes: [forged],
        localTracks: [MIC, SCREEN],
        grantedIdentities: new Set(),
        screenSid: 'TR_scr',
      }).trackPermissions
    ).toEqual([{ participantIdentity: 'embed_user_1', allowedTrackSids: ['TR_mic'] }]);
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

  it('a role on any kind but agent or SIP is staff (unknown kinds are restricted)', () => {
    const noKind = { identity: 'n', attributes: { [ATTR_ROLE]: 'observer' } };
    const agentWithRole = { ...agent, attributes: { [ATTR_ROLE]: 'rep' } };
    expect(
      computePermissions({
        remotes: [noKind, agentWithRole],
        localTracks: [MIC, SCREEN],
        grantedIdentities: new Set(),
        screenSid: 'TR_scr',
      }).trackPermissions
    ).toEqual([
      { participantIdentity: 'n', allowedTrackSids: ['TR_mic'] },
      { participantIdentity: 'agent-1', allowAll: true },
    ]);
  });

  it('staff never get the camera, granted or not', () => {
    const CAM = { trackSid: 'TR_cam', source: Track.Source.Camera };
    const observer = { ...rep, identity: 'obs-1', attributes: { [ATTR_ROLE]: 'observer' } };
    expect(
      computePermissions({
        remotes: [agent, rep, observer],
        localTracks: [MIC, CAM, SCREEN],
        grantedIdentities: new Set(['rep-1']),
        screenSid: 'TR_scr',
      }).trackPermissions
    ).toEqual([
      { participantIdentity: 'agent-1', allowAll: true },
      { participantIdentity: 'rep-1', allowedTrackSids: ['TR_mic', 'TR_scr'] },
      { participantIdentity: 'obs-1', allowedTrackSids: ['TR_mic'] },
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

/** Answers the prompt on screen as the overlay does: after the click guard, by identity. */
function answerHead(result: { current: ScreenViewerPermissions }, allow: boolean) {
  act(() => vi.advanceTimersByTime(VIEWER_CONSENT_CLICK_GUARD_MS));
  const identity = result.current.viewerConsentRequest!.identity;
  act(() => (allow ? result.current.allowViewer(identity) : result.current.denyViewer(identity)));
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

  it('with no share applies (true, []) unless staff are present, then mic only for them', () => {
    const fake = createFakeRoom();
    fake.publishMic('TR_mic');
    renderViewer(fake.room);
    expect(fake.setTrackSubscriptionPermissions).toHaveBeenCalledTimes(1);
    expect(lastCall(fake)).toEqual([true, []]);

    act(() => fake.addParticipant(fakeAgent()));
    act(() => fake.addParticipant(fakeSip()));
    expect(lastCall(fake)).toEqual([true, []]);
    const staff = staffParticipant();
    act(() => fake.addParticipant(staff));
    expect(lastCall(fake)).toEqual([
      false,
      [
        { participantIdentity: 'agent-1', allowAll: true },
        { participantIdentity: 'human-agent-sip', allowAll: true },
        { participantIdentity: 'rep-1', allowedTrackSids: ['TR_mic'] },
      ],
    ]);
    act(() => fake.removeParticipant(staff));
    expect(lastCall(fake)).toEqual([true, []]);
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

    act(() => fake.addParticipant(staffParticipant()));
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

  it('a synchronous SDK throw while a screen is live asks for a stop; with no screen it does not', () => {
    const fake = createFakeRoom();
    const onRestrictionRefused = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderViewer(fake.room, { onRestrictionRefused });
    fake.setTrackSubscriptionPermissions.mockImplementation(() => {
      throw new Error('signal down');
    });
    act(() => fake.addParticipant(fakeAgent()));
    expect(onRestrictionRefused).not.toHaveBeenCalled();
    act(() => {
      fake.publishScreen('TR_scr_1');
    });
    expect(onRestrictionRefused).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('a granted staff member who leaves and rejoins mid-share must be asked again', async () => {
    const fake = roomWithAgent();
    fake.publishMic('TR_mic');
    fake.publishScreen('TR_scr_1');
    const staff = staffParticipant();
    act(() => fake.addParticipant(staff));
    const { result } = renderViewer(fake.room);
    let pending!: Promise<string>;
    act(() => {
      pending = result.current.handleViewerConsent(request());
    });
    answerHead(result, true);
    await pending;
    expect(lastCall(fake)?.[1]).toContainEqual({
      participantIdentity: 'rep-1',
      allowedTrackSids: ['TR_mic', 'TR_scr_1'],
    });

    act(() => fake.removeParticipant(staff));
    act(() => fake.addParticipant(staffParticipant()));
    expect(lastCall(fake)?.[1]).toContainEqual({
      participantIdentity: 'rep-1',
      allowedTrackSids: ['TR_mic'],
    });
  });

  it.each([RoomEvent.ParticipantActive, RoomEvent.TrackPublished, RoomEvent.TrackUnpublished])(
    'a rejoin the SDK reports without a disconnect drops the grant (%s)',
    async (event) => {
      const fake = roomWithAgent();
      fake.publishMic('TR_mic');
      fake.publishScreen('TR_scr_1');
      const staff = { ...staffParticipant(), sid: 'PA_old' };
      act(() => fake.addParticipant(staff));
      const { result } = renderViewer(fake.room);
      let pending!: Promise<string>;
      act(() => {
        pending = result.current.handleViewerConsent(request());
      });
      answerHead(result, true);
      await pending;
      const granted = { participantIdentity: 'rep-1', allowedTrackSids: ['TR_mic', 'TR_scr_1'] };
      expect(lastCall(fake)?.[1]).toContainEqual(granted);

      act(() => fake.room.emit(event));
      expect(lastCall(fake)?.[1]).toContainEqual(granted); // same session keeps its grant

      staff.sid = 'PA_new'; // the SDK updates the participant it already has
      act(() => fake.room.emit(event));
      expect(lastCall(fake)?.[1]).toContainEqual({
        participantIdentity: 'rep-1',
        allowedTrackSids: ['TR_mic'],
      });
    }
  );

  it('no live share: answers no_share immediately, no prompt', async () => {
    const fake = roomWithAgent();
    act(() => fake.addParticipant(staffParticipant()));
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
    const staff = staffParticipant();
    staff.attributes[ATTR_DISPLAY_NAME] = 'Dana from Support';
    act(() => fake.addParticipant(staff));
    act(() => fake.addParticipant(staffParticipant('observer')));
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

    answerHead(result, true);
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
    act(() => fake.addParticipant(staffParticipant()));
    const { result } = renderViewer(fake.room);

    let pending!: Promise<string>;
    act(() => {
      pending = result.current.handleViewerConsent(request());
    });
    answerHead(result, true);
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
    act(() => fake.addParticipant(staffParticipant()));
    const { result } = renderViewer(fake.room);
    let pending!: Promise<string>;
    act(() => {
      pending = result.current.handleViewerConsent(request());
    });
    answerHead(result, false);
    expect(JSON.parse(await pending).outcome).toBe('declined');
    expect(lastCall(fake)?.[1]).toContainEqual({
      participantIdentity: 'rep-1',
      allowedTrackSids: [],
    });
  });

  it('times out after 30 s with `timeout`', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(staffParticipant()));
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
    act(() => fake.addParticipant(staffParticipant()));
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
    act(() => fake.addParticipant(staffParticipant()));
    const { result } = renderViewer(fake.room);
    for (const callerIdentity of ['rep-1', 'nobody-here']) {
      const answer = await result.current.handleViewerConsent({ ...request(), callerIdentity });
      expect(JSON.parse(answer)).toEqual({ v: 1, outcome: 'declined' });
    }
    expect(result.current.viewerConsentRequest).toBeNull();
    act(() => result.current.allowViewer('rep-1'));
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

  it('a repeat request for the same person joins the pending prompt instead of queueing', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(staffParticipant()));
    const { result } = renderViewer(fake.room);
    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => {
      first = result.current.handleViewerConsent(request());
    });
    await act(async () => {
      second = result.current.handleViewerConsent(request());
    });
    answerHead(result, true);
    expect(JSON.parse(await first).outcome).toBe('granted');
    expect(JSON.parse(await second).outcome).toBe('granted');
    expect(result.current.viewerConsentRequest).toBeNull();
  });

  it('two requests queue: the second is shown after the first is answered', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(staffParticipant()));
    act(() => fake.addParticipant(staffParticipant('observer')));
    const { result } = renderViewer(fake.room);
    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => {
      first = result.current.handleViewerConsent(request('rep-1', 'Dana'));
      second = result.current.handleViewerConsent(request('obs-1', 'Sam'));
    });
    expect(result.current.viewerConsentRequest?.identity).toBe('rep-1');
    answerHead(result, false);
    expect(result.current.viewerConsentRequest?.identity).toBe('obs-1');
    answerHead(result, true);
    expect(JSON.parse(await first).outcome).toBe('declined');
    expect(JSON.parse(await second).outcome).toBe('granted');
  });

  it('a queued prompt gets its full 30 s from when it is shown, not from when it was asked', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(staffParticipant()));
    act(() => fake.addParticipant(staffParticipant('observer')));
    const { result } = renderViewer(fake.room);
    let second!: Promise<string>;
    act(() => {
      void result.current.handleViewerConsent(request('rep-1', 'Dana'));
      second = result.current.handleViewerConsent(request('obs-1', 'Sam'));
    });
    act(() => vi.advanceTimersByTime(20_000));
    answerHead(result, false);
    expect(result.current.viewerConsentRequest).toMatchObject({
      identity: 'obs-1',
      expiresAt: Date.now() + VIEWER_CONSENT_TIMEOUT_S * 1000,
    });
    act(() => vi.advanceTimersByTime(VIEWER_CONSENT_TIMEOUT_S * 1000 - 1));
    expect(result.current.viewerConsentRequest?.identity).toBe('obs-1');
    act(() => vi.advanceTimersByTime(1));
    expect(JSON.parse(await second).outcome).toBe('timeout');
  });

  it('a double click across two queued prompts answers only the first', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(staffParticipant()));
    act(() => fake.addParticipant(staffParticipant('observer')));
    const { result } = renderViewer(fake.room);
    let first!: Promise<string>;
    act(() => {
      first = result.current.handleViewerConsent(request('rep-1', 'Dana'));
      void result.current.handleViewerConsent(request('obs-1', 'Sam'));
    });
    act(() => vi.advanceTimersByTime(VIEWER_CONSENT_CLICK_GUARD_MS));
    // The overlay's Allow is bound to the prompt it was rendered for.
    const allowShown = () =>
      result.current.allowViewer(result.current.viewerConsentRequest!.identity);
    act(allowShown);
    act(allowShown); // second click of the double tap, now over Sam's prompt
    expect(JSON.parse(await first).outcome).toBe('granted');
    expect(result.current.viewerConsentRequest?.identity).toBe('obs-1');
    // A stale click for the answered prompt never reaches the next one either.
    act(() => vi.advanceTimersByTime(VIEWER_CONSENT_CLICK_GUARD_MS));
    act(() => result.current.allowViewer('rep-1'));
    expect(result.current.viewerConsentRequest?.identity).toBe('obs-1');
    expect(lastCall(fake)?.[1]).toContainEqual({
      participantIdentity: 'obs-1',
      allowedTrackSids: [],
    });
  });

  it('every queued prompt gets its full 30 s once shown; all three are shown', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(staffParticipant()));
    act(() => fake.addParticipant(staffParticipant('observer')));
    act(() => fake.addParticipant(staffParticipant('rep', 'Lee', 'rep-3')));
    const { result } = renderViewer(fake.room);
    const outcomes: Record<string, string> = {};
    act(() => {
      for (const id of ['rep-1', 'obs-1', 'rep-3']) {
        void result.current
          .handleViewerConsent(request(id))
          .then((a) => (outcomes[id] = JSON.parse(a).outcome));
      }
    });
    for (const id of ['rep-1', 'obs-1', 'rep-3']) {
      expect(result.current.viewerConsentRequest).toMatchObject({
        identity: id,
        timeoutSeconds: VIEWER_CONSENT_TIMEOUT_S,
        expiresAt: Date.now() + VIEWER_CONSENT_TIMEOUT_S * 1000,
      });
      await act(async () => vi.advanceTimersByTimeAsync(VIEWER_CONSENT_TIMEOUT_S * 1000 - 1));
      expect(outcomes[id]).toBeUndefined(); // still open 1 ms before its own 30 s
      await act(async () => vi.advanceTimersByTimeAsync(1));
    }
    expect(outcomes).toEqual({ 'rep-1': 'timeout', 'obs-1': 'timeout', 'rep-3': 'timeout' });
    expect(result.current.viewerConsentRequest).toBeNull();
  });

  it('the asked person leaving closes their prompt as declined; the next gets its full 30 s', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    const leaver = staffParticipant();
    act(() => fake.addParticipant(leaver));
    act(() => fake.addParticipant(staffParticipant('observer')));
    const { result } = renderViewer(fake.room);
    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => {
      first = result.current.handleViewerConsent(request('rep-1'));
      second = result.current.handleViewerConsent(request('obs-1'));
    });
    act(() => vi.advanceTimersByTime(10_000));
    act(() => fake.removeParticipant(leaver));
    expect(JSON.parse(await first).outcome).toBe('declined');
    expect(result.current.viewerConsentRequest).toMatchObject({
      identity: 'obs-1',
      expiresAt: Date.now() + VIEWER_CONSENT_TIMEOUT_S * 1000,
    });
    // A late Allow for the person who left grants nothing.
    act(() => result.current.allowViewer('rep-1'));
    expect(lastCall(fake)?.[1]).not.toContainEqual(
      expect.objectContaining({ participantIdentity: 'rep-1' })
    );
    answerHead(result, false);
    expect(JSON.parse(await second).outcome).toBe('declined');
  });

  it('a queued (not yet shown) person leaving is dropped from the queue', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(staffParticipant()));
    const leaver = staffParticipant('observer');
    act(() => fake.addParticipant(leaver));
    const { result } = renderViewer(fake.room);
    let queued!: Promise<string>;
    act(() => {
      void result.current.handleViewerConsent(request('rep-1'));
      queued = result.current.handleViewerConsent(request('obs-1'));
    });
    act(() => fake.removeParticipant(leaver));
    expect(JSON.parse(await queued).outcome).toBe('declined');
    expect(result.current.viewerConsentRequest?.identity).toBe('rep-1');
    act(() => vi.advanceTimersByTime(VIEWER_CONSENT_TIMEOUT_S * 1000));
    expect(result.current.viewerConsentRequest).toBeNull(); // obs-1 is never shown
  });

  it('the prompt shows the role Connect minted, not the one in the request', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(staffParticipant('observer')));
    const { result } = renderViewer(fake.room);
    act(() => {
      void result.current.handleViewerConsent(request('obs-1')); // payload says role: 'rep'
    });
    expect(result.current.viewerConsentRequest?.role).toBe('observer');
  });

  it('a role whose identity lacks the matching staff prefix is declined, unprompted (C2)', async () => {
    const fake = roomWithAgent();
    fake.publishScreen('TR_scr_1');
    act(() => fake.addParticipant(staffParticipant('rep', undefined, 'embed_user_1')));
    act(() => fake.addParticipant(staffParticipant('observer', undefined, 'rep-2')));
    const { result } = renderViewer(fake.room);
    for (const identity of ['embed_user_1', 'rep-2']) {
      const answer = await result.current.handleViewerConsent(request(identity));
      expect(JSON.parse(answer).outcome).toBe('declined');
    }
    expect(result.current.viewerConsentRequest).toBeNull();
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

  it('a synchronous permissions throw during a live share takes the screen down', async () => {
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

  /**
   * Agent present, no staff yet (with staff the list is restricted anyway), share permitted:
   * the moment the screen is requested.
   */
  function sessionWithAgent() {
    stubNavigator({ capable: true });
    const fake = createFakeRoom();
    fake.grantScreenShare();
    fake.publishMic('TR_mic');
    fake.addParticipant(fakeAgent('agent-1'));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RoomContext.Provider value={fake.room as unknown as Room}>{children}</RoomContext.Provider>
    );
    const hook = renderHook(() => useScreenshareSession(), { wrapper });
    return { fake, hook };
  }

  const RESTRICTED = [false, [{ participantIdentity: 'agent-1', allowAll: true }]];

  /** The restricted call must come strictly before the publish request. */
  function expectRestrictedBeforePublish(fake: ReturnType<typeof createFakeRoom>) {
    const publishOrder = fake.setScreenShareEnabled.mock.invocationCallOrder[0];
    const calls = fake.setTrackSubscriptionPermissions.mock.calls;
    const orders = fake.setTrackSubscriptionPermissions.mock.invocationCallOrder;
    const lastBefore = calls.filter((_, i) => orders[i] < publishOrder).at(-1);
    expect(fake.setScreenShareEnabled.mock.calls[0][0]).toBe(true);
    expect(lastBefore).toEqual(RESTRICTED);
  }

  it('caller-initiated share: restricted before setScreenShareEnabled(true)', async () => {
    const { fake, hook } = sessionWithAgent();
    expect(lastCall(fake)).toEqual([true, []]);
    await act(async () => {
      await hook.result.current.startShare();
    });
    expectRestrictedBeforePublish(fake);
    vi.unstubAllGlobals();
  });

  it('agent-requested share: restricted before setScreenShareEnabled(true)', async () => {
    const { fake, hook } = sessionWithAgent();
    const rpc = fake.rpcHandlers.get(RPC_REQUEST_CONSENT)!({
      requestId: 'r',
      callerIdentity: 'agent-1',
      payload: JSON.stringify({
        v: SCREENSHARE_PROTOCOL_VERSION,
        scope: ['browser', 'window', 'monitor'],
        viewers: [{ role: 'agent' }],
        timeout_seconds: 30,
      }),
      responseTimeout: 45_000,
    });
    await waitFor(() => expect(hook.result.current.consentRequest).not.toBeNull());
    await act(async () => {
      await hook.result.current.acceptConsent();
    });
    await rpc;
    expectRestrictedBeforePublish(fake);
    vi.unstubAllGlobals();
  });

  it('a picker that publishes nothing restores (true, [])', async () => {
    const { fake, hook } = sessionWithAgent();
    fake.setScreenShareEnabled.mockImplementationOnce(async () => {
      throw Object.assign(new Error('dismissed'), { name: 'NotAllowedError' });
    });
    await act(async () => {
      await hook.result.current.startShare();
    });
    expect(lastCall(fake)).toEqual([true, []]);
    vi.unstubAllGlobals();
  });

  it('stays restricted while the picker is open: a staff join and a mic publish do not reopen it', async () => {
    const { fake, hook } = sessionWithAgent();
    const picker = holdPicker(fake);
    let share!: Promise<unknown>;
    act(() => {
      share = hook.result.current.startShare();
    });
    expect(lastCall(fake)).toEqual(RESTRICTED);

    act(() => fake.addParticipant(staffParticipant('observer')));
    expect(lastCall(fake)).toEqual([
      false,
      [
        { participantIdentity: 'agent-1', allowAll: true },
        { participantIdentity: 'obs-1', allowedTrackSids: ['TR_mic'] },
      ],
    ]);

    act(() => fake.publishMic('TR_mic_2'));
    expect(lastCall(fake)?.[0]).toBe(false);
    expect(lastCall(fake)?.[1]).toContainEqual({
      participantIdentity: 'obs-1',
      allowedTrackSids: ['TR_mic_2'],
    });

    await act(async () => {
      const pub = picker.release(fakePublication('window', 'TR_scr_new'));
      fake.room.emit(RoomEvent.LocalTrackPublished, pub);
      await share;
    });
    // From the first restricted call on, no staff list ever held the new screen sid.
    fake.setTrackSubscriptionPermissions.mock.calls.forEach(([all, perms]) => {
      (perms as { participantIdentity: string; allowedTrackSids?: string[] }[])
        .filter((entry) => entry.participantIdentity !== 'agent-1')
        .forEach((entry) => expect(entry.allowedTrackSids).not.toContain('TR_scr_new'));
      void all;
    });
    expect(lastCall(fake)?.[0]).toBe(false);
    vi.unstubAllGlobals();
  });

  it('cancelling the open picker lifts the start restriction; a staff joiner keeps mic only', async () => {
    const { fake, hook } = sessionWithAgent();
    fake.setScreenShareEnabled.mockImplementationOnce(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })), 0)
        )
    );
    let share!: Promise<unknown>;
    act(() => {
      share = hook.result.current.startShare();
    });
    act(() => fake.addParticipant(staffParticipant('observer')));
    expect(lastCall(fake)?.[0]).toBe(false);
    await act(async () => {
      await share;
    });
    expect(lastCall(fake)).toEqual([
      false,
      [
        { participantIdentity: 'agent-1', allowAll: true },
        { participantIdentity: 'obs-1', allowedTrackSids: ['TR_mic'] },
      ],
    ]);
    vi.unstubAllGlobals();
  });

  it('overlapping starts: the first one ending does not lift the restriction of the second', async () => {
    const { fake, hook } = sessionWithAgent();
    const first = holdPicker(fake);
    let a!: Promise<unknown>;
    act(() => {
      a = hook.result.current.startShare();
    });
    const second = holdPicker(fake);
    let b!: Promise<unknown>;
    act(() => {
      b = hook.result.current.startShare();
    });
    await act(async () => {
      first.release(undefined as unknown as ReturnType<typeof fakePublication>);
      fake.setPublished(undefined);
      await a;
    });
    expect(lastCall(fake)).toEqual(RESTRICTED);
    await act(async () => {
      second.release(undefined as unknown as ReturnType<typeof fakePublication>);
      fake.setPublished(undefined);
      await b;
    });
    expect(lastCall(fake)).toEqual([true, []]);
    vi.unstubAllGlobals();
  });

  it('if the restriction is refused synchronously, no picker opens', async () => {
    const { fake, hook } = sessionWithAgent();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fake.setTrackSubscriptionPermissions.mockImplementationOnce(() => {
      throw new Error('refused');
    });
    let response!: { result: string };
    await act(async () => {
      response = await hook.result.current.startShare();
    });
    expect(response.result).toBe('failed');
    expect(fake.setScreenShareEnabled).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});
