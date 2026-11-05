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

async function bodySent(fetchMock: ReturnType<typeof stubFetch>) {
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const init = fetchMock.mock.calls[0][1] as { body: string };
  return JSON.parse(init.body);
}
const capableSent = async (fetchMock: ReturnType<typeof stubFetch>) =>
  (await bodySent(fetchMock)).capable;

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

  it('reports the display panel on a browser that cannot capture (popup)', async () => {
    stubNavigator({ capable: false });
    const fetchMock = stubFetch();
    renderHook(() => useConnectionDetails(APP_CONFIG));
    expect(await bodySent(fetchMock)).toMatchObject({ capable: false, displayCapable: true });
  });

  it('never reports the display panel from a surface without it (inline bar)', async () => {
    stubNavigator({ capable: true });
    const fetchMock = stubFetch();
    renderHook(() => useConnectionDetails(APP_CONFIG, { screenshareUi: false }));
    expect((await bodySent(fetchMock)).displayCapable).toBe(false);
  });
});

describe('useConnectionDetails session token (TLZ-742)', () => {
  function bodyOf(fetchMock: ReturnType<typeof stubFetch>, call = 0) {
    const init = fetchMock.mock.calls[call][1] as { body: string };
    return JSON.parse(init.body);
  }

  it('sends the session token, read fresh on every fetch', async () => {
    stubNavigator({ capable: true });
    const fetchMock = stubFetch();
    let current = 'token-1';
    const config = { ...APP_CONFIG, getSessionToken: () => current } as AppConfig;
    const { result } = renderHook(() => useConnectionDetails(config));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock).sessionToken).toBe('token-1');

    // The partner page swapped in a fresh token before the visitor pressed Call.
    current = 'token-2';
    await result.current.refreshConnectionDetails();
    expect(bodyOf(fetchMock, fetchMock.mock.calls.length - 1).sessionToken).toBe('token-2');
  });

  it('sends no session token without one', async () => {
    stubNavigator({ capable: true });
    const fetchMock = stubFetch();
    renderHook(() => useConnectionDetails(APP_CONFIG));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOf(fetchMock)).not.toHaveProperty('sessionToken');
  });

  it('rejects with the reason when the widget refuses the token', async () => {
    stubNavigator({ capable: true });
    const fetchMock = stubFetch();
    const config = { ...APP_CONFIG, getSessionToken: () => 'stale' } as AppConfig;
    const { result } = renderHook(() => useConnectionDetails(config));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fetchMock.mockResolvedValueOnce({
      json: async () => ({ error: 'invalid_session_token', reason: 'expired' }),
    });
    await expect(result.current.refreshConnectionDetails()).rejects.toThrow(/expired/);
  });
});
