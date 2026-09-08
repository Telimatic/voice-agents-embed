'use client';

import * as React from 'react';
import { type TrackReference, VideoTrack } from '@livekit/components-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * TLZ-561 (A3). While a screen is being shared the caller must be able to see that it is,
 * and stop it, without hunting for the browser's own bar.
 *
 * Two pieces, because the panel can be closed:
 *  - `ShareBanner` sits at the top of the panel, with the one Stop control the widget
 *    owns and a live thumbnail of what the agent is actually seeing; and
 *  - `ShareBadge` rides the collapsed trigger, which is fixed to the viewport, so the
 *    sharing state is visible at any scroll position and with the panel shut.
 *
 * The panel itself is viewport-fixed (`agent-client.tsx`), so neither moves with the
 * page. Everything here is drawn from the widget's own CSS variables so that a branded
 * deployment (F5) styles them exactly like the rest of the widget.
 */

export interface ShareBannerProps {
  /** The caller's own screen track, shown at its real aspect rather than cropped square. */
  trackRef?: TrackReference;
  onStop: () => void;
  /** True while the stop is in flight, so Stop cannot be pressed twice. */
  stopping?: boolean;
  className?: string;
}

export function ShareBanner({ trackRef, onStop, stopping = false, className }: ShareBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="screenshare-banner"
      className={cn(
        'bg-bg2 border-separator1 dark:border-separator2 absolute inset-x-2 top-2 z-30',
        'flex items-center gap-2 rounded-2xl border p-2 drop-shadow-md',
        className
      )}
    >
      <span
        aria-hidden="true"
        className="bg-fgSerious size-2 shrink-0 animate-pulse rounded-full"
      />
      <div className="min-w-0 flex-1">
        <p className="text-fg1 truncate text-xs font-semibold">You are sharing your screen</p>
        <p className="text-fg1/60 truncate text-[11px]">
          The AI agent is the only viewer. No person sees your screen.
        </p>
      </div>

      {/* A widescreen desktop in a square 70px tile is unreadable, which makes it worse
          than no thumbnail at all: the caller cannot check what they are sharing. */}
      {trackRef && (
        <VideoTrack
          trackRef={trackRef}
          data-testid="screenshare-thumbnail"
          className="bg-bg3 border-separator1 dark:border-separator2 aspect-video w-20 shrink-0 rounded-md border object-contain"
        />
      )}

      <Button
        variant="destructive"
        size="sm"
        onClick={onStop}
        disabled={stopping}
        className="shrink-0"
      >
        {stopping ? 'Stopping…' : 'Stop'}
      </Button>
    </div>
  );
}

export interface ShareBadgeProps {
  className?: string;
}

/**
 * The collapsed trigger's sharing badge. Purely visual, and deliberately so: it is
 * rendered INSIDE the trigger button, and any text here would be folded into that
 * button's accessible name -- a screen-reader user would hear the sharing status
 * announced as the name of the button they are trying to press. The spoken half is
 * `ShareStatus`, rendered as a sibling of the button.
 */
export function ShareBadge({ className }: ShareBadgeProps) {
  return (
    <span
      aria-hidden="true"
      data-testid="screenshare-badge"
      className={cn(
        'bg-bgSerious border-bg1 pointer-events-none absolute -top-1 -right-1 z-30',
        'grid size-4 place-items-center rounded-full border',
        className
      )}
    >
      <span className="bg-fgSerious size-2 animate-pulse rounded-full" />
    </span>
  );
}

/**
 * The spoken half of the badge: a live region OUTSIDE the trigger button, so the sharing
 * state is announced without becoming the button's name.
 */
export function ShareStatus() {
  return (
    <span role="status" aria-live="polite" data-testid="screenshare-status" className="sr-only">
      You are sharing your screen
    </span>
  );
}

export default ShareBanner;
