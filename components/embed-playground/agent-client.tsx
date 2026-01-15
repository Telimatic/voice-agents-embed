'use client';

import { useEffect, useMemo, useState } from 'react';
import { Room, RoomEvent } from 'livekit-client';
import { RoomAudioRenderer, RoomContext, StartAudio } from '@livekit/components-react';
import useConnectionDetails from '@/hooks/use-connection-details';
import type { AppConfig, EmbedErrorDetails } from '@/lib/types';
import { cn } from '@/lib/utils';
import { PlaygroundInterface } from './playground-interface';

interface PlaygroundAgentClientProps {
  appConfig: AppConfig;
  agentName?: string;
  className?: string;
}

export default function PlaygroundAgentClient({
  appConfig,
  agentName,
  className,
}: PlaygroundAgentClientProps) {
  const room = useMemo(() => new Room(), []);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<EmbedErrorDetails | null>(null);
  const { refreshConnectionDetails } = useConnectionDetails(appConfig);

  useEffect(() => {
    const onConnected = () => {
      setIsConnected(true);
      setIsConnecting(false);
    };
    const onDisconnected = () => {
      setIsConnected(false);
      setIsConnecting(false);
    };
    const onMediaDevicesError = (error: Error) => {
      setError({
        title: 'Encountered an error with your media devices',
        description: `${error.name}: ${error.message}`,
      });
    };

    room.on(RoomEvent.Connected, onConnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.MediaDevicesError, onMediaDevicesError);

    return () => {
      room.off(RoomEvent.Connected, onConnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.MediaDevicesError, onMediaDevicesError);
    };
  }, [room]);

  // Auto-connect on mount
  useEffect(() => {
    if (room.state !== 'disconnected' || isConnecting) {
      return;
    }

    const connect = async () => {
      setIsConnecting(true);
      setError(null);

      try {
        const connectionDetails = await refreshConnectionDetails();
        await room.connect(connectionDetails.serverUrl, connectionDetails.participantToken);
        await room.localParticipant.setMicrophoneEnabled(true, undefined, {
          preConnectBuffer: appConfig.isPreConnectBufferEnabled,
        });
      } catch (err) {
        console.error('Error connecting to agent:', err);
        setIsConnecting(false);
        if (err instanceof Error) {
          setError({
            title: 'There was an error connecting to the agent',
            description: `${err.name}: ${err.message}`,
          });
        }
      }
    };

    connect();
  }, [room, refreshConnectionDetails, appConfig.isPreConnectBufferEnabled, isConnecting]);

  if (error) {
    return (
      <div
        className={cn(
          'bg-embed-bg flex h-full w-full items-center justify-center rounded-2xl p-6',
          className
        )}
      >
        <div className="space-y-2 text-center">
          <p className="text-destructive-foreground font-semibold">{error.title}</p>
          <p className="text-fg3 text-sm">{error.description}</p>
          <button
            onClick={() => {
              setError(null);
              room.disconnect();
            }}
            className="bg-primary text-primary-foreground hover:bg-primary-hover mt-4 rounded-full px-4 py-2 text-sm font-medium transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (!isConnected && isConnecting) {
    return (
      <div
        className={cn(
          'bg-embed-bg flex h-full w-full items-center justify-center rounded-2xl',
          className
        )}
      >
        <div className="space-y-3 text-center">
          <div className="border-fgAccent mx-auto h-10 w-10 animate-spin rounded-full border-2 border-t-transparent" />
          <p className="text-fg2 text-sm font-medium">Connecting to agent...</p>
        </div>
      </div>
    );
  }

  return (
    <RoomContext.Provider value={room}>
      <RoomAudioRenderer />
      <StartAudio label="Start Audio" />
      <div className={cn('h-full w-full', className)}>
        <PlaygroundInterface agentName={agentName} />
      </div>
    </RoomContext.Provider>
  );
}
