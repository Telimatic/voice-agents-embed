import type { ReactNode } from 'react';
import { Room } from 'livekit-client';
import { describe, expect, it } from 'vitest';
import { RoomContext } from '@livekit/components-react';
import { act, renderHook } from '@testing-library/react';
import { useScreenshareAgent } from '@/hooks/use-screenshare-peer';
import { ATTR_ALLOWED_SURFACES, ATTR_ENABLED } from '@/lib/screenshare-protocol';
import { createFakeRoom, fakeAgent } from './fake-room';

function renderAgent(room: ReturnType<typeof createFakeRoom>['room']) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RoomContext.Provider value={room as unknown as Room}>{children}</RoomContext.Provider>
  );
  return renderHook(() => useScreenshareAgent(), { wrapper });
}

describe('useScreenshareAgent allowedSurfaces', () => {
  it('offers every surface until an agent says otherwise', () => {
    const fake = createFakeRoom();
    const { result } = renderAgent(fake.room);
    expect(result.current.allowedSurfaces).toEqual(['browser', 'window', 'monitor']);
  });

  it('reads the agent attribute, in protocol order', () => {
    const fake = createFakeRoom();
    const { result } = renderAgent(fake.room);
    act(() => {
      fake.addParticipant(
        fakeAgent('agent-1', { [ATTR_ENABLED]: 'true', [ATTR_ALLOWED_SURFACES]: 'monitor,browser' })
      );
    });
    expect(result.current.agentReady).toBe(true);
    expect(result.current.allowedSurfaces).toEqual(['browser', 'monitor']);
  });

  it('follows the attribute when it changes after the agent joined', () => {
    const fake = createFakeRoom();
    const agent = fakeAgent('agent-1', { [ATTR_ENABLED]: 'false' });
    const { result } = renderAgent(fake.room);
    act(() => fake.addParticipant(agent));
    expect(result.current.agentReady).toBe(false);
    act(() =>
      fake.setParticipantAttributes(agent, {
        [ATTR_ENABLED]: 'true',
        [ATTR_ALLOWED_SURFACES]: 'window',
      })
    );
    expect(result.current.agentReady).toBe(true);
    expect(result.current.allowedSurfaces).toEqual(['window']);
  });

  it('falls back to every surface on a malformed or absent attribute', () => {
    const fake = createFakeRoom();
    const { result } = renderAgent(fake.room);
    act(() =>
      fake.addParticipant(
        fakeAgent('agent-1', { [ATTR_ENABLED]: 'true', [ATTR_ALLOWED_SURFACES]: 'tab,,' })
      )
    );
    expect(result.current.allowedSurfaces).toEqual(['browser', 'window', 'monitor']);
  });

  it('ignores surfaces advertised by an agent that is not ready', () => {
    const fake = createFakeRoom();
    const { result } = renderAgent(fake.room);
    act(() =>
      fake.addParticipant(
        fakeAgent('agent-1', { [ATTR_ENABLED]: 'false', [ATTR_ALLOWED_SURFACES]: 'window' })
      )
    );
    expect(result.current.agentReady).toBe(false);
    expect(result.current.allowedSurfaces).toEqual(['browser', 'window', 'monitor']);
  });
});
