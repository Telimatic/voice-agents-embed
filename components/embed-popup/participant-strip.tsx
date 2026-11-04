'use client';

import * as React from 'react';
import { useStaffParticipants } from '@/hooks/use-staff-participants';
import { cn } from '@/lib/utils';

/**
 * TLZ-561 (D7/D12). Tells the caller which team members are in the call. Reps are named;
 * observers are only counted. Drawn from the widget's own CSS variables (F5 branding).
 */
export function ParticipantStrip({ className }: { className?: string }) {
  const { reps, observers } = useStaffParticipants();
  if (reps.length === 0 && observers.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="participant-strip"
      className={cn(
        'bg-bg2 border-separator1 dark:border-separator2 text-fg1 absolute inset-x-2 z-20',
        'flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-xl border px-3 py-1.5 text-xs',
        className
      )}
    >
      {reps.map((rep) => (
        <span key={rep.identity} className="truncate">
          <span className="font-semibold">{rep.name}</span> · Team member joined
        </span>
      ))}
      {observers.length > 0 && (
        <span className="text-fg1/60">
          {observers.length} {observers.length === 1 ? 'observer' : 'observers'}
        </span>
      )}
    </div>
  );
}
