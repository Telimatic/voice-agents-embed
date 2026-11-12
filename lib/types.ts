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
  /**
   * TLZ-742. The current web call session token (popup: the script tag's data-session-token).
   * Read on every connection fetch, so a partner page can swap in a fresh token (they last 5
   * minutes) before the visitor presses Call.
   */
  getSessionToken?: () => string | undefined;

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
