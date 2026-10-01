import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-plugin-import cannot follow @testing-library/react's export map; `waitFor`
// is exported and resolves at runtime.
// eslint-disable-next-line import/named
import { renderHook, waitFor } from '@testing-library/react';
import useConnectionDetails from '@/hooks/use-connection-details';
import type { AppConfig } from '@/lib/types';
import { stubNavigator } from './fake-room';

const APP_CONFIG = { agentId: 'agent-1' } as AppConfig;

function stubFetch() {
  const fetchMock = vi.fn<
    (url: string, init?: RequestInit) => Promise<{ json: () => Promise<unknown> }>
  >(async () => ({
    json: async () => ({
      serverUrl: 'wss://example',
      roomName: 'room',
      participantName: 'Guest',
      participantToken: 'token',
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function capableSent(fetchMock: ReturnType<typeof stubFetch>) {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const init = fetchMock.mock.calls[0][1] as { body: string };
  return JSON.parse(init.body).capable;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useConnectionDetails capable flag (TLZ-561)', () => {
  it('reports a capable browser as capable by default (popup, playground)', async () => {
    stubNavigator({ capable: true });
    const fetchMock = stubFetch();
    renderHook(() => useConnectionDetails(APP_CONFIG));
    expect(await capableSent(fetchMock)).toBe(true);
  });

  it('never reports capable from a surface without screenshare UI (inline bar)', async () => {
    stubNavigator({ capable: true });
    const fetchMock = stubFetch();
    renderHook(() => useConnectionDetails(APP_CONFIG, { screenshareUi: false }));
    expect(await capableSent(fetchMock)).toBe(false);
  });
});
