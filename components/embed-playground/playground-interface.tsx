'use client';

import { useVoiceAssistant, useRoomContext, DisconnectButton } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import { PhoneDisconnectIcon, SparkleIcon } from '@phosphor-icons/react';
import { MicSelector } from './mic-selector';
import { MicToggle } from './mic-toggle';
import { StatusBadge } from './status-badge';
import type { TranscriptMessage } from '@/types/playground';
import { cn } from '@/lib/utils';

export function PlaygroundInterface({ agentName }: { agentName?: string }) {
  const { state } = useVoiceAssistant();
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const room = useRoomContext();

  // Listen to LiveKit transcription events
  useEffect(() => {
    if (!room) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleTranscription = (segments: any[], participant: any) => {
      segments.forEach((segment) => {
        const isAgent = participant?.identity?.toLowerCase().includes('agent');

        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === segment.id);
          const newMsg: TranscriptMessage = {
            id: segment.id,
            text: segment.text || segment.final,
            speaker: isAgent ? 'agent' : 'user',
            timestamp: Date.now(),
            isFinal: segment.final !== undefined,
          };

          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = newMsg;
            return updated;
          }
          return [...prev, newMsg];
        });
      });
    };

    room.on(RoomEvent.TranscriptionReceived, handleTranscription);
    return () => {
      room.off(RoomEvent.TranscriptionReceived, handleTranscription);
    };
  }, [room]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div className="w-full h-full bg-embed-bg rounded-2xl overflow-hidden flex flex-col border border-separator1">
      {/* Header */}
      <div className="px-4 py-3 border-b border-separator1 flex items-center justify-between bg-bg1/50 z-10 shrink-0 gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-1 overflow-hidden">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-fgAccent to-primary flex items-center justify-center text-white text-xs font-bold shrink-0">
            AI
          </div>
          <h2 className="font-bold text-fg0 text-sm truncate leading-tight">
            {agentName || 'Voice Agent'}
          </h2>
        </div>
        <div className="shrink-0">
          <MicSelector />
        </div>
      </div>

      {/* Transcript */}
      <div
        className="flex-1 overflow-y-auto p-4 space-y-4 bg-bg1/30 scroll-smooth scrollbar-custom"
        ref={scrollRef}
      >
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-fg4 gap-3 select-none opacity-80">
            <div className="w-12 h-12 rounded-xl bg-bg2 border border-separator1 flex items-center justify-center">
              <SparkleIcon size={20} weight="fill" className="text-fgAccent opacity-50" />
            </div>
            <p className="text-xs font-medium text-fg3">Agent is ready to chat</p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              'flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300',
              msg.speaker === 'user' ? 'flex-row-reverse' : ''
            )}
          >
            <div
              className={cn(
                'w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 text-[9px] font-bold ring-1 ring-inset',
                msg.speaker === 'user'
                  ? 'bg-primary text-primary-foreground ring-primary/20'
                  : 'bg-bg2 text-fg1 ring-separator1'
              )}
            >
              {msg.speaker === 'user' ? 'U' : 'AI'}
            </div>
            <div
              className={cn(
                'flex flex-col gap-1 max-w-[85%]',
                msg.speaker === 'user' ? 'items-end' : 'items-start'
              )}
            >
              <div
                className={cn(
                  'px-3.5 py-2 rounded-xl text-sm leading-relaxed border',
                  msg.speaker === 'user'
                    ? 'bg-primary text-primary-foreground border-primary rounded-tr-sm'
                    : 'bg-bg2 text-fg1 border-separator1 rounded-tl-sm'
                )}
              >
                {msg.text}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Footer controls */}
      <div className="p-4 bg-bg1 border-t border-separator1 shrink-0 relative z-20">
        <div className="flex items-center justify-center gap-3 w-full">
          <MicToggle />
          <StatusBadge state={state} />
          <DisconnectButton>
            <div className="px-4 py-2 bg-destructive hover:bg-destructive-hover text-destructive-foreground border border-destructive font-semibold rounded-full text-xs transition-all flex items-center gap-1.5 cursor-pointer h-9">
              <PhoneDisconnectIcon size={14} weight="bold" />
              <span>End Session</span>
            </div>
          </DisconnectButton>
        </div>
      </div>
    </div>
  );
}
