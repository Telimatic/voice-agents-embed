'use client';

import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { keepFocusInside, secondsRemaining } from '@/components/embed-popup/consent-overlay';
import { Button } from '@/components/ui/button';

/**
 * TLZ-561 (D6, D12). Asks the caller whether one named team member may see the screen
 * they are already sharing with the AI agent. Same look and keyboard behaviour as the
 * share consent prompt: it fills the panel, Escape means no, focus stays inside.
 */

export interface ViewerConsentOverlayProps {
  /** The team member's display name; empty falls back to "a team member". */
  name: string;
  timeoutSeconds: number;
  expiresAt: number;
  onAllow: () => void;
  onDeny: () => void;
}

export function ViewerConsentOverlay({
  name,
  timeoutSeconds,
  expiresAt,
  onAllow,
  onDeny,
}: ViewerConsentOverlayProps) {
  const who = name.trim() ? `${name.trim()} (team member)` : 'a team member';
  const panelRef = useRef<HTMLDivElement>(null);
  const [remaining, setRemaining] = useState(() => secondsRemaining(expiresAt));

  useEffect(() => {
    setRemaining(secondsRemaining(expiresAt));
    const interval = setInterval(() => setRemaining(secondsRemaining(expiresAt)), 250);
    return () => clearInterval(interval);
  }, [expiresAt]);

  // Focus moves into the prompt so it can be answered, and dismissed, from the keyboard.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onDeny();
        return;
      }
      keepFocusInside(panelRef.current, event);
    },
    [onDeny]
  );

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="viewer-consent-title"
      aria-describedby="viewer-consent-detail"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="bg-background/98 absolute inset-0 z-30 flex flex-col justify-center gap-3 rounded-[28px] p-5 outline-none"
    >
      <h2 id="viewer-consent-title" className="text-fg1 text-base font-semibold">
        Allow {who} to see your screen?
      </h2>

      <p id="viewer-consent-detail" className="text-fg1/60 text-xs">
        They can already hear you. They see your screen only if you allow it, and only for this
        share. You can stop sharing at any time.
      </p>

      <div className="flex flex-row gap-2 pt-1">
        <Button variant="primary" size="sm" onClick={onAllow}>
          Allow
        </Button>
        <Button variant="outline" size="sm" onClick={onDeny}>
          Don&apos;t allow
        </Button>
      </div>

      <p aria-live="polite" className="text-fg1/60 text-xs">
        {`This request expires in ${remaining}s.`}
      </p>
      <span className="sr-only">{`The request stands for ${timeoutSeconds} seconds.`}</span>
    </div>
  );
}

export default ViewerConsentOverlay;
