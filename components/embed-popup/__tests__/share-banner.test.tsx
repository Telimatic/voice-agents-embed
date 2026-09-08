import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-plugin-import cannot follow @testing-library/react's export map; `screen`
// is exported and resolves at runtime.
// eslint-disable-next-line import/named
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ShareBadge, ShareBanner } from '@/components/embed-popup/share-banner';

/**
 * TLZ-561 (A3, F5). The indicator has two jobs: say plainly that a screen is being
 * shared, and offer the one Stop control the widget owns. F5 adds a third -- everything
 * it draws comes from the widget's CSS variables, so a branded deployment styles it like
 * the rest of the widget rather than in the default palette.
 */
afterEach(cleanup);

describe('ShareBanner', () => {
  it('says a screen is being shared, and who can see it', () => {
    render(<ShareBanner onStop={() => {}} />);

    const banner = screen.getByTestId('screenshare-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText(/sharing your screen/i)).toBeInTheDocument();
    expect(screen.getByText(/only viewer/i)).toBeInTheDocument();
  });

  it('stops the share when Stop is pressed', () => {
    const onStop = vi.fn();
    render(<ShareBanner onStop={onStop} />);

    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('cannot be pressed twice while the stop is in flight', () => {
    const onStop = vi.fn();
    render(<ShareBanner onStop={onStop} stopping />);

    const button = screen.getByRole('button', { name: /stopping/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onStop).not.toHaveBeenCalled();
  });

  it('shows no thumbnail until there is a track to show', () => {
    render(<ShareBanner onStop={() => {}} />);
    expect(screen.queryByTestId('screenshare-thumbnail')).toBeNull();
  });

  it('draws only from the widget CSS variables, never a literal colour', () => {
    const { container } = render(<ShareBanner onStop={() => {}} />);
    const markup = container.innerHTML;

    // A hard-coded hex would survive re-branding and look wrong on a branded host.
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(markup).not.toMatch(/rgba?\(/i);
    expect(markup).toContain('bg-bg2');
    expect(markup).toContain('border-separator1');
  });
});

describe('ShareBadge', () => {
  it('states the sharing in words, not only in colour', () => {
    render(<ShareBadge />);

    const badge = screen.getByTestId('screenshare-badge');
    expect(badge).toHaveAttribute('role', 'status');
    expect(screen.getByText(/sharing your screen/i)).toBeInTheDocument();
    expect(badge.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
