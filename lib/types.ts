import type { TranscriptionSegment } from 'livekit-client';

export interface CombinedTranscription extends TranscriptionSegment {
  role: 'assistant' | 'user';
  receivedAtMediaTimestamp: number;
  receivedAt: number;
}
export type ThemeMode = 'dark' | 'light' | 'system';

export interface AppConfig {
  sandboxId?: string;
  agentId?: string;
  agentName?: string;
  connectionDetailsEndpoint?: string;

  supportsChatInput: boolean;
  supportsVideoInput: boolean;
  // TLZ-561 removed `supportsScreenShare`. Screenshare is resolved per session -- the
  // token's capability grant, the browser's ability to capture, and an agent in the room
  // that can receive the share -- so a build-time flag here could only ever contradict it.
  isPreConnectBufferEnabled: boolean;
}

export interface SandboxConfig {
  [key: string]:
    | { type: 'string'; value: string }
    | { type: 'number'; value: number }
    | { type: 'boolean'; value: boolean }
    | null;
}

export type EmbedErrorDetails = { title: React.ReactNode; description: React.ReactNode };
