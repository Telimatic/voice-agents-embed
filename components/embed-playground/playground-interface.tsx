'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RoomEvent, Track } from 'livekit-client';
import {
  DisconnectButton,
  type TrackReference,
  useLocalParticipant,
  useRoomContext,
  useVoiceAssistant,
} from '@livekit/components-react';
import {
  MonitorArrowUpIcon,
  PhoneDisconnectIcon,
  PhoneIcon,
  SparkleIcon,
  SpinnerIcon,
} from '@phosphor-icons/react';
import { ConsentOverlay } from '@/components/embed-popup/consent-overlay';
import { ShareBanner } from '@/components/embed-popup/share-banner';
import {
  useScreenshareCallerConsentNotifier,
  useScreenshareStopNotifier,
} from '@/hooks/use-screenshare-peer';
import { useScreenshareSession } from '@/hooks/use-screenshare-session';
import { cn } from '@/lib/utils';
import type { TranscriptMessage } from '@/types/playground';
import { MicSelector } from './mic-selector';
import { MicToggle } from './mic-toggle';
import { StatusBadge } from './status-badge';

export function PlaygroundInterface({ agentName }: { agentName?: string }) {
  const { state } = useVoiceAssistant();
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const room = useRoomContext();

  // TLZ-561. The same screenshare wiring as the popup (popup-view.tsx): the session hook
  // owns the consent prompt and the screen track, and offers a share only once the worker
  // has widened this participant's publish permission and a share-capable agent is in the
  // room. Without it the agent could ask for a screen this page had no way to answer.
  const { isScreenShareEnabled, localParticipant } = useLocalParticipant();
  const screenSharePublication = localParticipant?.getTrackPublication(Track.Source.ScreenShare);
  const localScreenShareTrack = useMemo<TrackReference | undefined>(
    () =>
      screenSharePublication
        ? {
            source: Track.Source.ScreenShare,
            participant: localParticipant,
            publication: screenSharePublication,
          }
        : undefined,
    [screenSharePublication, localParticipant]
  );
  const [sharePending, setSharePending] = useState(false);
  const notifyStopped = useScreenshareStopNotifier();
  const notifyCallerConsent = useScreenshareCallerConsentNotifier();
  const { canShare, consentRequest, acceptConsent, declineConsent, startShare, stopShare } =
    useScreenshareSession({ onStopped: notifyStopped, onCallerConsent: notifyCallerConsent });

  /** The one Stop path the page owns, shared by the banner and the share button. */
  const handleStopShare = useCallback(async () => {
    setSharePending(true);
    try {
      await stopShare('caller_stop');
    } finally {
      setSharePending(false);
    }
  }, [stopShare]);

  const handleShareToggle = useCallback(() => {
    void (async () => {
      if (isScreenShareEnabled) {
        await handleStopShare();
        return;
      }
      setSharePending(true);
      try {
        await startShare();
      } finally {
        setSharePending(false);
      }
    })();
  }, [handleStopShare, isScreenShareEnabled, startShare]);

  // Listen to transcription events
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
    <div className="bg-embed-bg border-separator1 relative flex h-full w-full flex-col overflow-hidden rounded-2xl border">
      {/* Header */}
      <div className="border-separator1 bg-bg1/50 z-10 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
          <div className="from-fgAccent to-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-white">
            <PhoneIcon size={16} weight="fill" />
          </div>
          <h2 className="text-fg0 truncate text-sm leading-tight font-bold">
            {agentName || 'Voice Agent'}
          </h2>
        </div>
        <div className="shrink-0">
          <MicSelector />
        </div>
      </div>

      {/* Transcript */}
      <div
        className="bg-bg1/30 scrollbar-custom flex-1 space-y-4 overflow-y-auto scroll-smooth p-4"
        ref={scrollRef}
      >
        {messages.length === 0 && (
          <div className="text-fg4 flex h-full flex-col items-center justify-center gap-3 opacity-80 select-none">
            <div className="bg-bg2 border-separator1 flex h-12 w-12 items-center justify-center rounded-xl border">
              <SparkleIcon size={20} weight="fill" className="text-fgAccent opacity-50" />
            </div>
            <p className="text-fg3 text-xs font-medium">Agent is ready to chat</p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              'animate-in fade-in slide-in-from-bottom-2 flex gap-3 duration-300',
              msg.speaker === 'user' ? 'flex-row-reverse' : ''
            )}
          >
            <div
              className={cn(
                'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg text-[9px] font-bold ring-1 ring-inset',
                msg.speaker === 'user'
                  ? 'bg-primary text-primary-foreground ring-primary/20'
                  : 'bg-bg2 text-fg1 ring-separator1'
              )}
            >
              {msg.speaker === 'user' ? 'U' : 'AI'}
            </div>
            <div
              className={cn(
                'flex max-w-[85%] flex-col gap-1',
                msg.speaker === 'user' ? 'items-end' : 'items-start'
              )}
            >
              <div
                className={cn(
                  'rounded-xl border px-3.5 py-2 text-sm leading-relaxed',
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
      <div className="bg-bg1 border-separator1 relative z-20 shrink-0 border-t p-4">
        <div className="flex w-full items-center justify-center gap-3">
          <MicToggle />
          {canShare && (
            <button
              type="button"
              aria-label={isScreenShareEnabled ? 'Stop sharing your screen' : 'Share your screen'}
              aria-pressed={isScreenShareEnabled}
              onClick={handleShareToggle}
              disabled={sharePending}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full border transition-all duration-200 disabled:opacity-60',
                isScreenShareEnabled
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-bg2 text-fg1 border-separator1 hover:bg-bg3 hover:border-separator2'
              )}
            >
              {sharePending ? (
                <SpinnerIcon size={16} weight="bold" className="animate-spin" />
              ) : (
                <MonitorArrowUpIcon size={16} weight="bold" />
              )}
            </button>
          )}
          <StatusBadge state={state} />
          <DisconnectButton>
            <div className="bg-destructive hover:bg-destructive-hover text-destructive-foreground border-destructive flex h-9 cursor-pointer items-center gap-1.5 rounded-full border px-4 py-2 text-xs font-semibold transition-all">
              <PhoneDisconnectIcon size={14} weight="bold" />
              <span>End Session</span>
            </div>
          </DisconnectButton>
        </div>
      </div>

      {/* Sharing indicator. Publication state, not the hook's flag, so the banner reflects
          what is actually being published. */}
      {isScreenShareEnabled && (
        <ShareBanner
          trackRef={localScreenShareTrack}
          stopping={sharePending}
          onStop={() => {
            void handleStopShare();
          }}
        />
      )}

      {/* The iframe theme sets --background to transparent so the page blends into the
          host, which leaves the overlay's own bg-background with no fill here: the
          transcript showed through it. This layer gives it the playground's solid
          background; the overlay itself is shared with the popup and left unchanged. */}
      {consentRequest && (
        <div className="bg-embed-bg absolute inset-0 z-30 rounded-2xl">
          <ConsentOverlay
            agentName={agentName}
            surfaces={consentRequest.surfaces}
            timeoutSeconds={consentRequest.timeoutSeconds}
            expiresAt={consentRequest.expiresAt}
            capturing={consentRequest.capturing}
            onAccept={() => {
              void acceptConsent();
            }}
            onDecline={declineConsent}
          />
        </div>
      )}
    </div>
  );
}
