import { Room } from 'livekit-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomContext } from '@livekit/components-react';
import { TrackSource } from '@livekit/protocol';
// eslint-disable-next-line import/named
import { cleanup, render, screen } from '@testing-library/react';
import { PopupView } from '@/components/embed-popup/popup-view';
import { createFakeRoom, fakeAgent, stubNavigator } from '@/hooks/__tests__/fake-room';
import type { AppConfig } from '@/lib/types';

const fakeRef = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeRoom> | null }));

vi.mock('@livekit/components-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@livekit/components-react')>()),
  BarVisualizer: () => null,
  VideoTrack: () => null,
  useRemoteParticipants: () => [{ isAgent: true }],
  useVoiceAssistant: () => ({ state: 'listening' }),
  useLocalParticipant: () => ({
    isCameraEnabled: false,
    isScreenShareEnabled: false,
    localParticipant: fakeRef.current!.room.localParticipant,
  }),
  useLocalParticipantPermissions: () => fakeRef.current!.room.localParticipant.permissions,
}));
vi.mock('@/hooks/use-chat-and-transcription', () => ({
  default: () => ({ messages: [], send: vi.fn() }),
}));
vi.mock('@/components/embed-popup/transcript', () => ({ Transcript: () => null }));
vi.mock('@/hooks/useDebug', () => ({ useDebugMode: () => {} }));
vi.mock('@/hooks/use-agent-control-bar', () => {
  const t = { enabled: false, pending: false, toggle: () => {} };
  return {
    useAgentControlBar: () => ({
      micTrackRef: undefined,
      visibleControls: { microphone: false, camera: false, screenShare: true, chat: false },
      cameraToggle: t,
      microphoneToggle: t,
      screenShareToggle: t,
      handleAudioDeviceChange: () => {},
      handleVideoDeviceChange: () => {},
    }),
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PopupView photo fallback (TLZ-561, A4)', () => {
  it('offers "Send a photo" on a browser that cannot capture, with no screen-share permission', () => {
    stubNavigator({ capable: false });
    const fake = createFakeRoom();
    fakeRef.current = fake;
    // The worker sets `enabled` for this browser but never widens the publish permission.
    fake.remoteParticipants.set('agent-1', fakeAgent());
    expect(fake.room.localParticipant.permissions.canPublishSources).not.toContain(
      TrackSource.SCREEN_SHARE
    );
    render(
      <RoomContext.Provider value={fake.room as unknown as Room}>
        <PopupView
          appConfig={{} as AppConfig}
          disabled={false}
          sessionStarted
          onEmbedError={() => {}}
        />
      </RoomContext.Provider>
    );
    expect(screen.getByText('Send a photo')).toBeTruthy();
  });
});
