'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Track } from 'livekit-client';
import { AnimatePresence, motion } from 'motion/react';
import {
  type AgentState,
  type TrackReference,
  VideoTrack,
  useLocalParticipant,
  useRoomContext,
  useVoiceAssistant,
} from '@livekit/components-react';
import type { ConnectionDetails } from '@/app/api/connection-details/route';
import { ActionBar } from '@/components/embed-popup/action-bar';
import { AudioVisualizer } from '@/components/embed-popup/audio-visualizer';
import { ConsentOverlay } from '@/components/embed-popup/consent-overlay';
import { ShareBanner } from '@/components/embed-popup/share-banner';
import { Transcript } from '@/components/embed-popup/transcript';
import useChatAndTranscription from '@/hooks/use-chat-and-transcription';
import { useScreenshareStopNotifier } from '@/hooks/use-screenshare-peer';
import { useScreenshareSession } from '@/hooks/use-screenshare-session';
import { useDebugMode } from '@/hooks/useDebug';
import type { AppConfig, EmbedErrorDetails } from '@/lib/types';
import { cn } from '@/lib/utils';

const TILE_TRANSITION = {
  type: 'spring' as const,
  stiffness: 675,
  damping: 75,
  mass: 1,
};

const TranscriptMotion = motion.create(Transcript);

export function useLocalTrackRef(source: Track.Source) {
  const { localParticipant } = useLocalParticipant();
  const publication = localParticipant.getTrackPublication(source);
  const trackRef = useMemo<TrackReference | undefined>(
    () => (publication ? { source, participant: localParticipant, publication } : undefined),
    [source, publication, localParticipant]
  );
  return trackRef;
}

function isAgentAvailable(agentState: AgentState) {
  return agentState == 'listening' || agentState == 'thinking' || agentState == 'speaking';
}

type PopupProps = {
  appConfig: AppConfig;
  disabled: boolean;
  sessionStarted: boolean;
  onEmbedError: React.Dispatch<React.SetStateAction<EmbedErrorDetails | null>>;
  // TLZ-561. Resolved by the token route per-agent; absent before the first token comes
  // back (or if that fetch never lands, e.g. `disabled`/pre-connect states).
  connectionCapabilities?: ConnectionDetails['capabilities'];
};

export const PopupView = ({
  appConfig,
  disabled,
  sessionStarted,
  onEmbedError,
  connectionCapabilities,
  ref,
}: React.ComponentProps<'div'> & PopupProps) => {
  useDebugMode();

  const room = useRoomContext();
  const {
    state: agentState,
    audioTrack: agentAudioTrack,
    videoTrack: agentVideoTrack,
  } = useVoiceAssistant();
  const { isCameraEnabled, isScreenShareEnabled } = useLocalParticipant();
  const cameraTrack: TrackReference | undefined = useLocalTrackRef(Track.Source.Camera);
  // The caller's OWN screen track. `useTracks` would also return a remote one.
  const localScreenShareTrack: TrackReference | undefined = useLocalTrackRef(
    Track.Source.ScreenShare
  );
  const [chatOpen, setChatOpen] = useState(false);
  const [sharePending, setSharePending] = useState(false);
  const { messages, send } = useChatAndTranscription();
  // TLZ-561. One ended share, one `screenshare.notify`: the session hook reports a stop
  // exactly once, from its single unpublish listener, and this turns that report into the
  // notification. Sending it from anywhere else would race that listener.
  const notifyStopped = useScreenshareStopNotifier();
  // TLZ-561. Owns the capability attribute, the consent prompt and the screen track.
  // Both values come from the token route, which resolved org policy and minted the grant
  // to match: an organization without the feature is never offered the prompt at all,
  // rather than being shown one whose publish the token would then refuse.
  const { canShare, consentRequest, acceptConsent, declineConsent, startShare, stopShare } =
    useScreenshareSession({
      enabled: connectionCapabilities?.screenshare === true,
      allowedSurfaces: connectionCapabilities?.allowedSurfaces,
      onStopped: notifyStopped,
    });

  const { supportsChatInput, supportsVideoInput } = appConfig;
  const capabilities = {
    supportsChatInput,
    supportsVideoInput,
    // The token granted the capability, this browser can capture a display, and an agent
    // that can receive the share is in the room. The last one is not decoration: without
    // it the caller can start a share nobody is listening for.
    supportsScreenShare: canShare,
  };

  /** The one Stop path the widget owns, shared by the banner and the control bar. */
  const handleStopShare = useCallback(async () => {
    setSharePending(true);
    try {
      await stopShare('caller_stop');
    } finally {
      setSharePending(false);
    }
  }, [stopShare]);

  const handleShareToggle = useCallback(
    (pressed: boolean) => {
      void (async () => {
        if (!pressed) {
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
    },
    [handleStopShare, startShare]
  );

  async function onSendMessage(message: string) {
    await send(message);
    return;
  }

  // If the agent hasn't connected after an interval,
  // then show an error - something must not be working
  useEffect(() => {
    if (!sessionStarted) {
      return;
    }

    const timeout = setTimeout(() => {
      if (!isAgentAvailable(agentState)) {
        const reason =
          agentState === 'connecting'
            ? 'Agent did not join the room. '
            : 'Agent connected but did not complete initializing. ';

        onEmbedError({
          title: 'Session ended',
          description: <p className="w-full">{reason}</p>,
        });
      }
    }, 10_000);

    return () => clearTimeout(timeout);
  }, [agentState, sessionStarted, room, onEmbedError]);

  return (
    <div ref={ref} inert={disabled} className="flex h-full w-full flex-col overflow-hidden">
      <div className="relative flex h-full shrink-1 grow-1 flex-col">
        {/* Transcript */}
        <TranscriptMotion
          initial={{
            y: 10,
            opacity: 0,
          }}
          animate={{
            y: chatOpen ? 0 : 10,
            opacity: chatOpen ? 1 : 0,
          }}
          transition={{
            type: 'spring',
            duration: 0.5,
            bounce: 0,
          }}
          messages={messages}
        />

        {/* Audio Visualizer */}
        <AnimatePresence>
          {!agentVideoTrack && (
            <motion.div
              key="audio-visualizer"
              initial={{
                scale: 1,
                left: '50%',
                top: '50%',
                translateX: '-50%',
                translateY: '-50%',
                transformOrigin: 'center top',
              }}
              animate={{
                left: chatOpen && (isCameraEnabled || isScreenShareEnabled) ? '39%' : '50%',
                scale: chatOpen ? 0.275 : 1,
                top: chatOpen ? '12px' : '50%',
                translateY: chatOpen ? '0' : '-50%',
                transformOrigin: chatOpen ? 'center top' : 'center center',
              }}
              transition={TILE_TRANSITION}
              className={cn(
                'bg-bg1 dark:bg-bg2 pointer-events-none absolute flex aspect-square w-64 items-center justify-center rounded-2xl border border-transparent transition-colors',
                chatOpen && 'border-separator1 dark:border-separator2 drop-shadow-2xl'
              )}
            >
              <AudioVisualizer agentState={agentState} audioTrack={agentAudioTrack} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Avatar (Background)) */}
        <AnimatePresence>
          {agentVideoTrack && (
            <motion.div
              key="avatar"
              initial={{
                maskImage:
                  'radial-gradient(circle, rgba(0, 0, 0, 1) 0, rgba(0, 0, 0, 1) 40px, transparent 40px)',
                filter: 'blur(20px)',
              }}
              animate={{
                opacity: chatOpen ? 0 : 1,
                maskImage:
                  'radial-gradient(circle, rgba(0, 0, 0, 1) 0, rgba(0, 0, 0, 1) 500px, transparent 500px)',
                filter: 'blur(0px)',
              }}
              transition={{
                opacity: {
                  ease: 'linear',
                  duration: 0.2,
                },
                maskImage: {
                  ease: 'linear',
                  duration: 1,
                },
                filter: {
                  ease: 'linear',
                  duration: 1,
                },
              }}
              className="border-separator1 dark:border-separator2 pointer-events-none absolute inset-1 drop-shadow-lg/20"
            >
              <VideoTrack
                trackRef={agentVideoTrack}
                width={agentVideoTrack?.publication.dimensions?.width ?? 0}
                height={agentVideoTrack?.publication.dimensions?.height ?? 0}
                className="h-full rounded-[24px] bg-black object-cover"
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Avatar (Tile) */}
        <AnimatePresence>
          {agentVideoTrack && chatOpen && (
            <motion.div
              key="audio-visualizer"
              initial={{
                opacity: 0,
                scale: 0.5,
                left: isCameraEnabled || isScreenShareEnabled ? '39%' : '50%',
                top: '12px',
                translateX: '-50%',
                transformOrigin: 'center top',
              }}
              animate={{
                opacity: 1,
                scale: 1,
                left: isCameraEnabled || isScreenShareEnabled ? '37.5%' : '50%',
              }}
              transition={TILE_TRANSITION}
              className="border-separator1 dark:border-separator2 pointer-events-none absolute drop-shadow-lg/20"
            >
              <VideoTrack
                trackRef={agentVideoTrack}
                width={agentVideoTrack?.publication.dimensions?.width ?? 0}
                height={agentVideoTrack?.publication.dimensions?.height ?? 0}
                className="aspect-square w-[70px] rounded-md bg-black object-cover"
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Camera (Tile). The screen share is deliberately NOT shown here any more: a
            square 70px tile crops a widescreen desktop to uselessness, so it has its own
            correctly-proportioned thumbnail in the sharing banner instead. */}
        <AnimatePresence>
          {cameraTrack && isCameraEnabled && (
            <motion.div
              key="camera"
              initial={{
                scale: 0.5,
                opacity: 0,
                right: '12px',
                top: '346px',
                transformOrigin: 'center bottom',
              }}
              animate={{
                scale: 1,
                opacity: 1,
                top: chatOpen ? '12px' : '346px',
                right: chatOpen ? '106px' : '12px',
                transformOrigin: chatOpen ? 'center top' : 'center bottom',
              }}
              exit={{
                scale: 0.5,
                opacity: 0,
              }}
              transition={TILE_TRANSITION}
              className="border-separator1 dark:border-separator2 pointer-events-none absolute drop-shadow-lg/20"
            >
              <VideoTrack
                trackRef={cameraTrack}
                width={cameraTrack?.publication.dimensions?.width ?? 0}
                height={cameraTrack?.publication.dimensions?.height ?? 0}
                className="aspect-square w-[70px] rounded-md bg-black object-cover"
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Action Bar */}
        <motion.div
          initial={{
            opacity: 0,
            translateY: 8,
          }}
          animate={{
            opacity: sessionStarted ? 1 : 0,
            translateY: sessionStarted ? 0 : 8,
          }}
          transition={{
            delay: 0.5,
          }}
        >
          <ActionBar
            capabilities={capabilities}
            // Driven by the screenshare session rather than LiveKit's own track toggle,
            // so a start records consent and a stop is attributed as `caller_stop`.
            screenShareControl={{
              // Publication state, so the control always reflects what is actually being
              // published and the caller's own Stop can never be out of reach.
              pressed: isScreenShareEnabled,
              pending: sharePending,
              onPressedChange: handleShareToggle,
            }}
            onSendMessage={onSendMessage}
            onChatOpenChange={setChatOpen}
          />
        </motion.div>

        {/* Sharing indicator (TLZ-561, A3). Publication state, not the hook's flag, so
            the banner reflects what is actually being published. */}
        {isScreenShareEnabled && (
          <ShareBanner
            trackRef={localScreenShareTrack}
            stopping={sharePending}
            onStop={() => {
              void handleStopShare();
            }}
          />
        )}

        {/* Screenshare consent (TLZ-561). Panel-filling: agreeing to share a screen is
            not a decision to make out of the corner of an eye. */}
        {consentRequest && (
          <ConsentOverlay
            agentName={appConfig.agentName}
            surfaces={consentRequest.surfaces}
            timeoutSeconds={consentRequest.timeoutSeconds}
            expiresAt={consentRequest.expiresAt}
            capturing={consentRequest.capturing}
            onAccept={() => {
              void acceptConsent();
            }}
            onDecline={declineConsent}
          />
        )}
      </div>
    </div>
  );
};
