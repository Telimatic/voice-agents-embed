import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-plugin-import cannot follow @testing-library/react's export map; `screen`
// is exported and resolves at runtime.
// eslint-disable-next-line import/named
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConsentOverlay } from '@/components/embed-popup/consent-overlay';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderOverlay(props: Partial<React.ComponentProps<typeof ConsentOverlay>> = {}) {
  const onAccept = vi.fn();
  const onDecline = vi.fn();
  render(
    <ConsentOverlay
      agentName="Linda"
      surfaces={['browser', 'window', 'monitor']}
      timeoutSeconds={30}
      expiresAt={Date.now() + 30_000}
      onAccept={onAccept}
      onDecline={onDecline}
      {...props}
    />
  );
  return { onAccept, onDecline };
}

describe('ConsentOverlay', () => {
  it('names the agent asking', () => {
    renderOverlay();
    expect(screen.getByRole('dialog')).toHaveTextContent(/Linda would like to see your screen/i);
  });

  it('falls back to a neutral name when the agent has none', () => {
    renderOverlay({ agentName: undefined });
    expect(screen.getByRole('dialog')).toHaveTextContent(/The assistant would like to see/i);
  });

  it('lists only the surfaces policy allows', () => {
    renderOverlay({ surfaces: ['browser', 'window'] });
    expect(screen.getByText('A browser tab')).toBeInTheDocument();
    expect(screen.getByText('An app window')).toBeInTheDocument();
    expect(screen.queryByText('Your entire screen')).not.toBeInTheDocument();
  });

  it('states in one line that the AI agent is the only viewer', () => {
    renderOverlay();
    expect(
      screen.getByText(/The AI agent is the only viewer — no person sees your screen/i)
    ).toBeInTheDocument();
  });

  it('offers Share and Not now, and reports which was pressed', () => {
    const { onAccept, onDecline } = renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('is dismissible from the keyboard', () => {
    const { onDecline } = renderOverlay();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('shows the expiry counting down rather than letting it lapse silently', () => {
    vi.useFakeTimers();
    const start = Date.now();
    render(
      <ConsentOverlay
        agentName="Linda"
        surfaces={['browser']}
        timeoutSeconds={30}
        expiresAt={start + 30_000}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
      />
    );
    expect(screen.getByText('This request expires in 30s.')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText('This request expires in 25s.')).toBeInTheDocument();
  });

  it('tells the caller to answer the browser picker once Share is pressed', () => {
    renderOverlay({ capturing: true });
    expect(screen.getByRole('button', { name: /Choose what to share/i })).toBeDisabled();
    expect(screen.getByText(/Pick a tab, window or screen/i)).toBeInTheDocument();
  });
});
