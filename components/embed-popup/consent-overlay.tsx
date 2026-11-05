'use client';

import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ShareSurface } from '@/lib/screenshare-protocol';
import { cn } from '@/lib/utils';

/**
 * TLZ-561 (A2). The consent prompt. It fills the panel because agreeing to share a
 * screen is not a decision to make out of the corner of an eye, and it says who is
 * watching, what can be shared, and how long the offer stands.
 */

const SURFACE_LABELS: Record<ShareSurface, string> = {
  browser: 'A browser tab',
  window: 'An app window',
  monitor: 'Your entire screen',
};

export interface ConsentOverlayProps {
  /** The agent's name, so the caller knows exactly who is asking. */
  agentName?: string;
  surfaces: ShareSurface[];
  timeoutSeconds: number;
  /** Wall-clock deadline; the countdown is shown rather than left to expire silently. */
  expiresAt: number;
  /** True while the browser's own picker is open. */
  capturing?: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

export function secondsRemaining(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

/**
 * aria-modal is a promise that focus stays inside; Tab is where that promise is kept or
 * broken. Shared with the viewer-consent prompt.
 */
/**
 * The focused element in `node`'s own tree. Inside the popup's shadow root,
 * document.activeElement is only the shadow host.
 */
export function activeElementOf(node: Node | null): Element | null {
  const root = node?.getRootNode() as Document | ShadowRoot | undefined;
  return root?.activeElement ?? document.activeElement;
}

export function keepFocusInside(
  panel: HTMLElement | null,
  event: React.KeyboardEvent<HTMLElement>
): void {
  if (event.key !== 'Tab' || !panel) {
    return;
  }
  const focusable = Array.from(
    panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  );
  if (focusable.length === 0) {
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = activeElementOf(panel);

  if (event.shiftKey && (active === first || active === panel)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

export function ConsentOverlay({
  agentName,
  surfaces,
  timeoutSeconds,
  expiresAt,
  capturing = false,
  onAccept,
  onDecline,
}: ConsentOverlayProps) {
  const who = agentName?.trim() ? agentName.trim() : 'The assistant';
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
        // While the browser's own picker is open the answer is no longer ours to give:
        // the request has been accepted and only the picker can decide what happens next.
        if (capturing) {
          return;
        }
        event.stopPropagation();
        onDecline();
        return;
      }

      keepFocusInside(panelRef.current, event);
    },
    [capturing, onDecline]
  );

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="screenshare-consent-title"
      aria-describedby="screenshare-consent-viewers"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        'bg-embed-bg absolute inset-0 z-30 flex flex-col justify-center gap-3 rounded-[28px] p-5 outline-none'
      )}
    >
      <h2 id="screenshare-consent-title" className="text-fg1 text-base font-semibold">
        {who} would like to see your screen
      </h2>

      <p className="text-fg1/80 text-sm">You choose what to share:</p>
      <ul className="text-fg1/80 list-disc space-y-1 pl-5 text-sm">
        {surfaces.map((surface) => (
          <li key={surface}>{SURFACE_LABELS[surface]}</li>
        ))}
      </ul>

      <p id="screenshare-consent-viewers" className="text-fg1/60 text-xs">
        The AI agent is the only viewer — no person sees your screen, and you can stop sharing at
        any time.
      </p>

      <div className="flex flex-row gap-2 pt-1">
        <Button variant="primary" size="sm" onClick={onAccept} disabled={capturing}>
          {capturing ? 'Choose what to share…' : 'Share'}
        </Button>
        {/* Locked while the picker is open: declining here would answer the agent "no
            share" while a share the caller is still choosing may yet arrive. */}
        <Button variant="outline" size="sm" onClick={onDecline} disabled={capturing}>
          Not now
        </Button>
      </div>

      <p aria-live="polite" className="text-fg1/60 text-xs">
        {capturing
          ? 'Pick a tab, window or screen in your browser’s prompt.'
          : `This request expires in ${remaining}s.`}
      </p>
      <span className="sr-only">{`The request stands for ${timeoutSeconds} seconds.`}</span>
    </div>
  );
}

export default ConsentOverlay;
