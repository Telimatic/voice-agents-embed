import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-plugin-import cannot follow @testing-library/react's export map; `screen`
// is exported and resolves at runtime.
// eslint-disable-next-line import/named
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ViewerConsentOverlay } from '@/components/embed-popup/viewer-consent-overlay';

afterEach(cleanup);

function renderOverlay(name = 'Dana', role: 'rep' | 'observer' = 'rep', container?: HTMLElement) {
  const onAllow = vi.fn();
  const onDeny = vi.fn();
  render(
    <ViewerConsentOverlay
      name={name}
      role={role}
      timeoutSeconds={30}
      expiresAt={Date.now() + 30_000}
      onAllow={onAllow}
      onDeny={onDeny}
    />,
    container ? { container } : undefined
  );
  return { onAllow, onDeny };
}

describe('ViewerConsentOverlay', () => {
  it('names the team member and takes focus', () => {
    renderOverlay();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Allow Dana (team member) to see your screen?');
    expect(document.activeElement).toBe(dialog);
  });

  it('falls back to a neutral name', () => {
    renderOverlay('  ');
    expect(screen.getByRole('dialog')).toHaveTextContent('Allow a team member to see your screen?');
  });

  it('says when the person is an observer', () => {
    renderOverlay('Sam', 'observer');
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Allow Sam (observer) to see your screen?'
    );
    cleanup();
    renderOverlay(' ', 'observer');
    expect(screen.getByRole('dialog')).toHaveTextContent('Allow an observer to see your screen?');
  });

  it('keeps Tab inside the prompt when it renders in a shadow root (the popup)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const container = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(container);
    renderOverlay('Dana', 'rep', container);
    const root = host.shadowRoot!;
    const [allow, deny] = Array.from(root.querySelectorAll('button'));
    deny.focus();
    fireEvent.keyDown(root.querySelector('[role="dialog"]')!, { key: 'Tab' });
    expect(root.activeElement).toBe(allow);
    fireEvent.keyDown(root.querySelector('[role="dialog"]')!, { key: 'Tab', shiftKey: true });
    expect(root.activeElement).toBe(deny);
    cleanup();
    host.remove();
  });

  it('Allow, Don’t allow and Escape answer', () => {
    const { onAllow, onDeny } = renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onAllow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: "Don't allow" }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onDeny).toHaveBeenCalledTimes(2);
  });

  it('the countdown is not a live region; one warning is announced near the end', () => {
    vi.useFakeTimers();
    renderOverlay();
    expect(screen.getByText(/This request expires in/).closest('[aria-live]')).toBeNull();
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe('');
    act(() => vi.advanceTimersByTime(20_500));
    expect(live.textContent).toBe('About 10 seconds left to answer.');
    vi.useRealTimers();
  });

  it('gives focus back to where it was when it closes', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const view = render(
      <ViewerConsentOverlay
        name="Dana"
        role="rep"
        timeoutSeconds={30}
        expiresAt={Date.now() + 30_000}
        onAllow={() => {}}
        onDeny={() => {}}
      />
    );
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
