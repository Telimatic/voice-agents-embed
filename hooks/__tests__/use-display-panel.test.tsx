import { Room } from 'livekit-client';
import { describe, expect, it, vi } from 'vitest';
import { RoomContext } from '@livekit/components-react';
// eslint-disable-next-line import/named
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ContentPanel } from '@/components/embed-popup/content-panel';
import {
  RPC_DISPLAY_CLEAR,
  RPC_DISPLAY_HIGHLIGHT,
  RPC_DISPLAY_NOTIFY,
  RPC_DISPLAY_PUSH,
  SCREENSHARE_PROTOCOL_VERSION as V,
} from '@/lib/screenshare-protocol';
import { createFakeRoom, fakeAgent, fakeHuman } from './fake-room';

function setup() {
  const fake = createFakeRoom();
  fake.remoteParticipants.set('agent-1', fakeAgent('agent-1'));
  fake.remoteParticipants.set('rep-1', fakeHuman('rep-1'));
  render(
    <RoomContext.Provider value={fake.room as unknown as Room}>
      <ContentPanel />
    </RoomContext.Provider>
  );
  const call = async (
    method: string,
    body: Record<string, unknown> | string,
    callerIdentity = 'agent-1'
  ) => {
    let out = '';
    await act(async () => {
      out = await fake.rpcHandlers.get(method)!({
        requestId: 'r',
        callerIdentity,
        payload: typeof body === 'string' ? body : JSON.stringify({ v: V, ...body }),
        responseTimeout: 5000,
      });
    });
    return JSON.parse(out) as { ok: boolean; error?: string };
  };
  const push = (extra: Record<string, unknown>) => call(RPC_DISPLAY_PUSH, { title: 'T', ...extra });
  const notified = () =>
    fake.performRpc.mock.calls
      .filter(([a]) => a.method === RPC_DISPLAY_NOTIFY)
      .map(([a]) => JSON.parse(a.payload).event);
  return { fake, call, push, notified };
}

describe('useDisplayPanel / ContentPanel', () => {
  it('url push: sandboxed iframe plus an always-visible Open in new tab link', async () => {
    const { push } = setup();
    expect(await push({ id: 'a', kind: 'url', url: 'https://example.com/x' })).toEqual({
      v: V,
      ok: true,
    });
    const frame = screen.getByTitle('T');
    expect(frame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-forms allow-same-origin allow-popups'
    );
    const link = screen.getByText('Open in new tab');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('payment push: card with Pay now link, no iframe, notifies payment_opened on click', async () => {
    const { push, notified } = setup();
    await push({ id: 'p', kind: 'payment', url: 'https://pay.example/s', amount_label: '$5.00' });
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText('$5.00')).toBeTruthy();
    const pay = screen.getByText('Pay now');
    expect(pay.getAttribute('target')).toBe('_blank');
    expect(pay.getAttribute('rel')).toBe('noopener noreferrer');
    fireEvent.click(pay);
    expect(notified()).toEqual(['payment_opened']);
  });

  it('steps highlight marks exactly one step; out of range and wrong id are ok:false', async () => {
    const { push, call } = setup();
    await push({ id: 's', kind: 'steps', steps: ['one', 'two', 'three'] });
    expect((await call(RPC_DISPLAY_HIGHLIGHT, { id: 's', step: 1 })).ok).toBe(true);
    const marked = document.querySelectorAll('[data-highlighted="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toBe('two');
    expect((await call(RPC_DISPLAY_HIGHLIGHT, { id: 's', step: 9 })).ok).toBe(false);
    expect((await call(RPC_DISPLAY_HIGHLIGHT, { id: 'other', step: 0 })).ok).toBe(false);
    expect(document.querySelectorAll('[data-highlighted="true"]')).toHaveLength(1);
  });

  it('region highlight on an image draws one box; a push replaces content and clears it', async () => {
    const { push, call } = setup();
    await push({ id: 'i', kind: 'image', url: 'https://example.com/a.png' });
    await call(RPC_DISPLAY_HIGHLIGHT, { id: 'i', region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });
    expect(screen.getAllByTestId('display-region-highlight')).toHaveLength(1);
    await push({ id: 'i2', kind: 'image', url: 'https://example.com/b.png' });
    expect(screen.queryByTestId('display-region-highlight')).toBeNull();
    // The old id is no longer current.
    expect(
      (await call(RPC_DISPLAY_HIGHLIGHT, { id: 'i', region: { x: 0, y: 0, w: 1, h: 1 } })).ok
    ).toBe(false);
  });

  it('close, minimize and Reopen last each notify; reopen persists until disconnect', async () => {
    const { push, notified, fake } = setup();
    await push({ id: 'a', kind: 'url', url: 'https://example.com/x' });
    fireEvent.click(screen.getByText('Minimize'));
    expect(screen.queryByTestId('display-panel')).toBeNull();
    fireEvent.click(screen.getByText('Reopen last'));
    expect(screen.getByTestId('display-panel')).toBeTruthy();
    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByTestId('display-panel')).toBeNull();
    fireEvent.click(screen.getByText('Reopen last'));
    expect(screen.getByTestId('display-panel')).toBeTruthy();
    expect(notified()).toEqual(['minimized', 'reopened', 'dismissed', 'reopened']);
    expect(fake.performRpc.mock.calls[0][0].destinationIdentity).toBe('agent-1');
    act(() => fake.room.emit('disconnected'));
    expect(screen.queryByText('Reopen last')).toBeNull();
    expect(screen.queryByTestId('display-panel')).toBeNull();
  });

  it('display.clear hides the panel but keeps Reopen last', async () => {
    const { push, call } = setup();
    await push({ id: 'a', kind: 'url', url: 'https://example.com/x' });
    expect((await call(RPC_DISPLAY_CLEAR, {})).ok).toBe(true);
    expect(screen.queryByTestId('display-panel')).toBeNull();
    expect(screen.getByText('Reopen last')).toBeTruthy();
  });

  it('rejects non-https, malformed JSON and bad highlight payloads with bad_payload', async () => {
    const { push, call } = setup();
    expect(await push({ id: 'a', kind: 'url', url: 'http://example.com' })).toEqual({
      v: V,
      ok: false,
      error: 'bad_payload',
    });
    expect((await call(RPC_DISPLAY_PUSH, 'not json')).error).toBe('bad_payload');
    expect((await call(RPC_DISPLAY_HIGHLIGHT, { id: 'a' })).error).toBe('bad_payload');
    expect((await call(RPC_DISPLAY_CLEAR, 'nope')).error).toBe('bad_payload');
    expect(screen.queryByTestId('display-panel')).toBeNull();
  });

  it('unregisters its RPC methods on unmount', () => {
    const fake = createFakeRoom();
    const { unmount } = render(
      <RoomContext.Provider value={fake.room as unknown as Room}>
        <ContentPanel />
      </RoomContext.Provider>
    );
    expect(fake.rpcHandlers.size).toBe(3);
    unmount();
    expect(fake.rpcHandlers.size).toBe(0);
  });

  it('refuses a push from the avatar worker (lk.publish_on_behalf)', async () => {
    const { fake } = setup();
    fake.remoteParticipants.set('avatar-1', {
      ...fakeAgent('avatar-1'),
      attributes: { 'lk.publish_on_behalf': 'agent-1' },
    });
    const out = await fake.rpcHandlers.get(RPC_DISPLAY_PUSH)!({
      requestId: 'r',
      callerIdentity: 'avatar-1',
      payload: JSON.stringify({
        v: V,
        title: 'T',
        id: 'a',
        kind: 'url',
        url: 'https://example.com/x',
      }),
      responseTimeout: 5000,
    });
    expect(JSON.parse(out).ok).toBe(false);
    expect(screen.queryByTitle('T')).toBeNull();
  });

  it('refuses push, highlight and clear from a non-agent participant and changes nothing', async () => {
    const { push, call } = setup();
    await push({ id: 's', kind: 'steps', steps: ['one', 'two'] });
    const refused = async (m: string, b: Record<string, unknown>, who: string) =>
      expect(await call(m, b, who)).toEqual({ v: V, ok: false, error: 'bad_payload' });
    await refused(
      RPC_DISPLAY_PUSH,
      { id: 'x', kind: 'url', title: 'X', url: 'https://e.com' },
      'rep-1'
    );
    await refused(RPC_DISPLAY_HIGHLIGHT, { id: 's', step: 0 }, 'rep-1');
    await refused(RPC_DISPLAY_CLEAR, {}, 'rep-1');
    await refused(RPC_DISPLAY_CLEAR, {}, 'unknown');
    expect(screen.getByText('two')).toBeTruthy();
    expect(document.querySelectorAll('[data-highlighted="true"]')).toHaveLength(0);
    expect(screen.getByTestId('display-panel')).toBeTruthy();
  });

  it('does not iframe a same-origin url, only offers the new-tab link', async () => {
    const { push } = setup();
    vi.stubGlobal('location', { origin: 'https://app.example' });
    await push({ id: 'a', kind: 'url', url: 'https://app.example/x' });
    vi.unstubAllGlobals();
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByText('Open in new tab')).toBeTruthy();
  });

  it('Escape dismisses with a notify and focus lands on the heading when opened', async () => {
    const { push, notified } = setup();
    await push({ id: 'a', kind: 'url', url: 'https://example.com/x' });
    expect(document.activeElement?.tagName).toBe('H2');
    fireEvent.keyDown(screen.getByTestId('display-panel'), { key: 'Escape' });
    expect(screen.queryByTestId('display-panel')).toBeNull();
    expect(notified()).toEqual(['dismissed']);
  });
});
