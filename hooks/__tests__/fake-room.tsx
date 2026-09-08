import { ParticipantKind, RoomEvent, Track } from 'livekit-client';
import { vi } from 'vitest';
import { ATTR_ENABLED, SCREENSHARE_PROTOCOL_VERSION } from '@/lib/screenshare-protocol';

/** What the widget passes to `localParticipant.performRpc`, typed so tests can read it. */
export type PerformRpcArgs = {
  destinationIdentity: string;
  method: string;
  payload: string;
  responseTimeout?: number;
};

/**
 * A room that behaves like the SDK in the ways the screenshare hooks depend on. Shared by
 * the session tests and the stop-notification tests so the two cannot drift apart.
 *
 * The three behaviours that are NOT incidental:
 *  - `setScreenShareEnabled(false)` resolves to the publication it took down, or
 *    `undefined` when there was nothing to take down;
 *  - the unpublish event fires SYNCHRONOUSLY inside that call, which is what lets the
 *    listener consume the pending stop reason before the caller resumes; and
 *  - `remoteParticipants` is a live Map, so a participant added or removed by a test is
 *    visible to whatever the matching room event then triggers.
 */

export type RpcHandler = (data: {
  requestId: string;
  callerIdentity: string;
  payload: string;
  responseTimeout: number;
}) => Promise<string>;

const CAPABLE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36';

export function stubNavigator({ capable }: { capable: boolean }) {
  vi.stubGlobal('navigator', {
    userAgent: capable
      ? CAPABLE_UA
      : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari',
    mediaDevices: { getDisplayMedia: () => {} },
    maxTouchPoints: capable ? 0 : 5,
  });
}

export function fakePublication(displaySurface: string | undefined, trackSid = 'TR_screen_1') {
  return {
    trackSid,
    source: Track.Source.ScreenShare,
    track: {
      stop: vi.fn(),
      mediaStreamTrack: { getSettings: () => ({ displaySurface }) },
    },
  };
}

export type FakeParticipant = {
  identity: string;
  kind: ParticipantKind;
  attributes: Record<string, string>;
};

/** An agent participant, by default one that has said it can receive a share. */
export function fakeAgent(
  identity = 'agent-1',
  attributes: Record<string, string> = { [ATTR_ENABLED]: 'true' }
): FakeParticipant {
  return { identity, kind: ParticipantKind.AGENT, attributes };
}

export function fakeHuman(identity = 'human-1'): FakeParticipant {
  return { identity, kind: ParticipantKind.STANDARD, attributes: {} };
}

export function createFakeRoom() {
  const rpcHandlers = new Map<string, RpcHandler>();
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const remoteParticipants = new Map<string, FakeParticipant>();
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
  const performRpc = vi.fn(async (params: PerformRpcArgs) => {
    void params;
    return JSON.stringify({ v: SCREENSHARE_PROTOCOL_VERSION, ok: true });
  });

  const room = {
    state: 'connected',
    remoteParticipants,
    localParticipant: {
      identity: 'caller',
      setScreenShareEnabled,
      setAttributes,
      getTrackPublication,
      performRpc,
    },
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
      // A copy, because a listener may add or remove listeners while this runs.
      Array.from(listeners.get(event) ?? []).forEach((cb) => cb(...args));
    },
  };

  return {
    room,
    rpcHandlers,
    remoteParticipants,
    setScreenShareEnabled,
    setAttributes,
    getTrackPublication,
    performRpc,
    /** Mirrors the SDK: once the picker resolves, the publication exists on the participant. */
    setPublished: (pub: ReturnType<typeof fakePublication> | undefined) => {
      published = pub;
    },
    /** The SDK adds the participant BEFORE it emits, so the handler can see it. */
    addParticipant: (participant: FakeParticipant) => {
      remoteParticipants.set(participant.identity, participant);
      room.emit(RoomEvent.ParticipantConnected, participant);
    },
    /** ...and removes it BEFORE emitting the disconnect. */
    removeParticipant: (participant: FakeParticipant) => {
      remoteParticipants.delete(participant.identity);
      room.emit(RoomEvent.ParticipantDisconnected, participant);
    },
    /**
     * The browser's own "Stop sharing" bar. Nothing in the widget asks for this: the
     * capture ends and the SDK unpublishes the track, which is the only signal there is.
     * Clearing `published` matters -- a hand-emitted event that leaves the publication in
     * place would make `getTrackPublication` lie for the rest of the test.
     */
    stopFromBrowserBar: () => {
      const wasPublished = published;
      published = undefined;
      if (wasPublished) {
        room.emit(RoomEvent.LocalTrackUnpublished, wasPublished);
      }
    },
    setParticipantAttributes: (
      participant: FakeParticipant,
      attributes: Record<string, string>
    ) => {
      participant.attributes = attributes;
      room.emit(RoomEvent.ParticipantAttributesChanged, attributes, participant);
    },
  };
}

export type FakeRoom = ReturnType<typeof createFakeRoom>['room'];

/**
 * Hold the browser picker open. The promise stays unresolved until `release`, which is how
 * every "something answered while the caller was still choosing" case is driven.
 */
export function holdPicker(fake: ReturnType<typeof createFakeRoom>) {
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
