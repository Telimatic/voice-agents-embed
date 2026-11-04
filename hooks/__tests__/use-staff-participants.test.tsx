import type { ReactNode } from 'react';
import { Room } from 'livekit-client';
import { describe, expect, it } from 'vitest';
import { RoomContext } from '@livekit/components-react';
import { act, render, renderHook } from '@testing-library/react';
import { ParticipantStrip } from '@/components/embed-popup/participant-strip';
import { useStaffParticipants } from '@/hooks/use-staff-participants';
import { createFakeRoom, fakeAgent, fakeHuman, staffParticipant } from './fake-room';

const wrap = (fake: ReturnType<typeof createFakeRoom>) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <RoomContext.Provider value={fake.room as unknown as Room}>{children}</RoomContext.Provider>
    );
  };

describe('useStaffParticipants', () => {
  it('splits reps and observers, ignoring agents, plain humans and unknown roles', () => {
    const fake = createFakeRoom();
    const { result } = renderHook(() => useStaffParticipants(), { wrapper: wrap(fake) });
    act(() => {
      fake.addParticipant(staffParticipant('rep', 'Dana'));
      fake.addParticipant(staffParticipant('observer', 'Sam'));
      fake.addParticipant(staffParticipant('admin', 'Eve'));
      fake.addParticipant(fakeAgent());
      fake.addParticipant(fakeHuman());
    });
    expect(result.current.reps.map((s) => s.name)).toEqual(['Dana']);
    expect(result.current.observers.map((s) => s.name)).toEqual(['Sam']);
  });

  it('falls back to "Team member" when the display name is missing', () => {
    const fake = createFakeRoom();
    const { result } = renderHook(() => useStaffParticipants(), { wrapper: wrap(fake) });
    act(() => fake.addParticipant(staffParticipant('rep')));
    expect(result.current.reps[0].name).toBe('Team member');
  });

  it('ignores a non-standard participant carrying the role attribute', () => {
    const fake = createFakeRoom();
    const { result } = renderHook(() => useStaffParticipants(), { wrapper: wrap(fake) });
    act(() => fake.addParticipant({ ...staffParticipant('rep', 'Bot'), kind: fakeAgent().kind }));
    expect(result.current.reps).toEqual([]);
  });

  it('picks up a role attribute that arrives after the join', () => {
    const fake = createFakeRoom();
    const { result } = renderHook(() => useStaffParticipants(), { wrapper: wrap(fake) });
    const p = fakeHuman('late');
    act(() => fake.addParticipant(p));
    expect(result.current.reps).toEqual([]);
    act(() => fake.setParticipantAttributes(p, staffParticipant('rep', 'Lee').attributes));
    expect(result.current.reps.map((s) => s.name)).toEqual(['Lee']);
  });
});

describe('ParticipantStrip', () => {
  it('shows a joined rep and an observer count, and clears on leave', () => {
    const fake = createFakeRoom();
    const { queryByTestId, getByTestId } = render(<ParticipantStrip />, { wrapper: wrap(fake) });
    expect(queryByTestId('participant-strip')).toBeNull();
    const rep = staffParticipant('rep', 'Dana');
    const obs = staffParticipant('observer', 'Sam');
    act(() => {
      fake.addParticipant(rep);
      fake.addParticipant(obs);
    });
    const strip = getByTestId('participant-strip');
    expect(strip.getAttribute('aria-live')).toBe('polite');
    expect(strip.textContent).toContain('Dana · Team member joined');
    expect(strip.textContent).toContain('1 observer');
    act(() => {
      fake.removeParticipant(rep);
      fake.removeParticipant(obs);
    });
    expect(queryByTestId('participant-strip')).toBeNull();
  });
});
