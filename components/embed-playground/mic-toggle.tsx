'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import { MicrophoneIcon, MicrophoneSlashIcon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

export function MicToggle() {
  const { localParticipant } = useLocalParticipant();
  const [isMuted, setIsMuted] = useState(false);

  useEffect(() => {
    if (!localParticipant) return;
    setIsMuted(!localParticipant.isMicrophoneEnabled);
  }, [localParticipant, localParticipant?.isMicrophoneEnabled]);

  const toggleMic = useCallback(async () => {
    if (!localParticipant) return;
    const newState = !localParticipant.isMicrophoneEnabled;
    try {
      await localParticipant.setMicrophoneEnabled(newState);
      setIsMuted(!newState);
    } catch (e) {
      console.error('Failed to toggle mic:', e);
    }
  }, [localParticipant]);

  return (
    <button
      onClick={toggleMic}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-full border transition-all duration-200',
        isMuted
          ? 'bg-destructive text-destructive-foreground border-destructive hover:bg-destructive-hover'
          : 'bg-bg2 text-fg1 border-separator1 hover:bg-bg3 hover:border-separator2'
      )}
    >
      {isMuted ? (
        <MicrophoneSlashIcon size={16} weight="bold" />
      ) : (
        <MicrophoneIcon size={16} weight="bold" />
      )}
    </button>
  );
}
