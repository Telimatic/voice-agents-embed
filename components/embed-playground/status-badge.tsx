'use client';

import { type AgentState } from '@livekit/components-react';
import { cn } from '@/lib/utils';

export function StatusBadge({ state }: { state: AgentState }) {
  const isListening = state === 'listening';
  const isSpeaking = state === 'speaking';
  const isThinking = state === 'thinking';
  const isConnecting = state === 'connecting' || state === 'initializing';

  const colorClass = isListening
    ? 'bg-bgSuccess text-fgSuccess border-separatorSuccess'
    : isSpeaking
      ? 'bg-bgAccent text-fgAccent border-separatorAccent'
      : isThinking
        ? 'bg-bgModerate text-fgModerate border-separatorModerate'
        : isConnecting
          ? 'bg-bg2 text-fg2 border-separator1'
          : 'bg-bg2 text-fg3 border-separator1';

  const dotColor = isListening
    ? 'bg-fgSuccess'
    : isSpeaking
      ? 'bg-fgAccent'
      : isThinking
        ? 'bg-fgModerate'
        : 'bg-fg4';

  const showPing = isListening || isSpeaking || isThinking;

  const displayState = isConnecting ? 'connecting' : state;

  return (
    <div
      className={cn(
        'flex h-9 items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-bold tracking-wider uppercase transition-colors',
        colorClass
      )}
    >
      {showPing ? (
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span
            className={cn(
              'absolute inline-flex h-full w-full animate-ping rounded-full opacity-75',
              dotColor
            )}
          />
          <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', dotColor)} />
        </span>
      ) : (
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotColor)} />
      )}
      <span className="truncate">{displayState}</span>
    </div>
  );
}
