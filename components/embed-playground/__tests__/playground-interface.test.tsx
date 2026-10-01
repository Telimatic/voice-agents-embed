import type { ReactNode } from 'react';
import type { Room } from 'livekit-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomContext } from '@livekit/components-react';
// eslint-plugin-import cannot follow @testing-library/react's export map; `screen`
// and `waitFor` are exported and resolve at runtime.
// eslint-disable-next-line import/named
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { PlaygroundInterface } from '@/components/embed-playground/playground-interface';
import { createFakeRoom, fakeAgent, stubNavigator } from '@/hooks/__tests__/fake-room';
import { RPC_REQUEST_CONSENT, SCREENSHARE_PROTOCOL_VERSION } from '@/lib/screenshare-protocol';

// The fake room drives the screenshare hooks the way the SDK does; these three
// components-react pieces read SDK internals it does not model, and none of them is what
// this file tests. Everything else (RoomContext, useRoomContext) is the real module.
vi.mock('@livekit/components-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@livekit/components-react')>();
  return {
    ...actual,
    useVoiceAssistant: () => ({ state: 'listening' }),
    useLocalParticipant: () => ({ isScreenShareEnabled: false, localParticipant: undefined }),
    DisconnectButton: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  };
});
vi.mock('@/components/embed-playground/mic-selector', () => ({ MicSelector: () => null }));
vi.mock('@/components/embed-playground/mic-toggle', () => ({ MicToggle: () => null }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderPlayground(fake: ReturnType<typeof createFakeRoom>) {
  return render(
    <RoomContext.Provider value={fake.room as unknown as Room}>
      <PlaygroundInterface agentName="Raven" />
    </RoomContext.Provider>
  );
}

const shareButton = () => screen.queryByRole('button', { name: 'Share your screen' });

describe('PlaygroundInterface screenshare (TLZ-561)', () => {
  it('offers no share button until the worker widens the permission, and hides it again when revoked', async () => {
    stubNavigator({ capable: true });
    const fake = createFakeRoom();
    fake.addParticipant(fakeAgent());
    renderPlayground(fake);

    await waitFor(() => expect(fake.rpcHandlers.has(RPC_REQUEST_CONSENT)).toBe(true));
    expect(shareButton()).toBeNull();

    act(() => fake.grantScreenShare());
    await waitFor(() => expect(shareButton()).not.toBeNull());

    act(() => fake.revokeScreenShare());
    await waitFor(() => expect(shareButton()).toBeNull());
  });

  it('never offers a share for an agent that has not enabled screenshare', async () => {
    stubNavigator({ capable: true });
    const fake = createFakeRoom();
    fake.addParticipant(fakeAgent('agent-1', {}));
    fake.grantScreenShare();
    renderPlayground(fake);

    await waitFor(() => expect(fake.rpcHandlers.has(RPC_REQUEST_CONSENT)).toBe(true));
    expect(shareButton()).toBeNull();
  });

  it('shows the consent prompt, named for the agent, when the agent asks to see the screen', async () => {
    stubNavigator({ capable: true });
    const fake = createFakeRoom();
    fake.addParticipant(fakeAgent());
    fake.grantScreenShare();
    renderPlayground(fake);
    await waitFor(() => expect(fake.rpcHandlers.has(RPC_REQUEST_CONSENT)).toBe(true));

    void fake.rpcHandlers.get(RPC_REQUEST_CONSENT)!({
      requestId: 'req_1',
      callerIdentity: 'agent-1',
      payload: JSON.stringify({
        v: SCREENSHARE_PROTOCOL_VERSION,
        scope: ['browser', 'window', 'monitor'],
        viewers: [{ role: 'agent' }],
        timeout_seconds: 30,
      }),
      responseTimeout: 45_000,
    });

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Raven would like to see your screen');
  });
});
