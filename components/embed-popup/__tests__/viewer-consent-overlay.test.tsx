import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-plugin-import cannot follow @testing-library/react's export map; `screen`
// is exported and resolves at runtime.
// eslint-disable-next-line import/named
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ViewerConsentOverlay } from '@/components/embed-popup/viewer-consent-overlay';

afterEach(cleanup);

function renderOverlay(name = 'Dana') {
  const onAllow = vi.fn();
  const onDeny = vi.fn();
  render(
    <ViewerConsentOverlay
      name={name}
      timeoutSeconds={30}
      expiresAt={Date.now() + 30_000}
      onAllow={onAllow}
      onDeny={onDeny}
    />
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

  it('Allow, Don’t allow and Escape answer', () => {
    const { onAllow, onDeny } = renderOverlay();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onAllow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: "Don't allow" }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onDeny).toHaveBeenCalledTimes(2);
  });
});
