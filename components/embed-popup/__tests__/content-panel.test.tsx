import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line import/named
import { cleanup, render, screen } from '@testing-library/react';
import { ContentPanel } from '@/components/embed-popup/content-panel';

vi.mock('@livekit/components-react', () => ({ useRoomContext: () => undefined }));
vi.mock('@/hooks/use-display-panel', () => ({
  useDisplayPanel: () => ({
    item: { id: 'p1', kind: 'steps', title: 'How to reset', steps: ['Unplug it', 'Wait'] },
    highlight: null,
    mode: 'open',
    last: null,
    close: vi.fn(),
    minimize: vi.fn(),
    reopen: vi.fn(),
    paymentOpened: vi.fn(),
  }),
}));

afterEach(cleanup);

describe('ContentPanel', () => {
  it('has its own solid fill, so the transcript never shows through it', () => {
    // Inside the iframe the theme makes --background transparent (theme-provider), so
    // bg-background would leave the panel see-through; --embed-bg is the widget's own fill.
    render(<ContentPanel />);
    const panel = screen.getByRole('dialog', { name: 'How to reset' });
    expect(panel.className).toContain('bg-embed-bg');
    expect(panel.className).not.toMatch(/\bbg-background\b/);
  });
});
