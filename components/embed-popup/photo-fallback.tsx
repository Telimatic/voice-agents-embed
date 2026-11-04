'use client';

import * as React from 'react';
import { PHOTO_MAX_BYTES, PHOTO_TOPIC } from '@/lib/screenshare-protocol';

/**
 * TLZ-561 (A4). A browser that cannot share its screen says so and offers a photo instead,
 * sent to the AI agent alone over a LiveKit byte stream on `PHOTO_TOPIC`.
 */
export interface PhotoFallbackProps {
  onClose: () => void;
  /** The AI agent's identity. Without one nothing is sent: an unaddressed send broadcasts. */
  agentIdentity: string | null;
  /** The local participant (anything with `sendFile`). */
  participant: {
    sendFile: (
      file: File,
      options?: { topic?: string; destinationIdentities?: string[] }
    ) => Promise<unknown>;
  };
}

export function PhotoFallback({ participant, agentIdentity, onClose }: PhotoFallbackProps) {
  const [status, setStatus] = React.useState<{ kind: 'error' | 'sent'; text: string } | null>(null);

  const [sending, setSending] = React.useState(false);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(closeTimer.current), []);

  async function onChange(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file || sending) {
      return;
    }
    setStatus(null);
    if (!file.type.startsWith('image/')) {
      setStatus({ kind: 'error', text: 'Please choose an image file.' });
    } else if (file.size > PHOTO_MAX_BYTES) {
      setStatus({
        kind: 'error',
        text: `That photo is too large. Please choose one under ${PHOTO_MAX_BYTES / (1024 * 1024)} MB.`,
      });
    } else if (!agentIdentity) {
      setStatus({ kind: 'error', text: 'The assistant is not available to receive a photo.' });
    } else {
      setSending(true);
      try {
        await participant.sendFile(file, {
          topic: PHOTO_TOPIC,
          destinationIdentities: [agentIdentity],
        });
        setStatus({ kind: 'sent', text: 'Photo sent.' });
        closeTimer.current = setTimeout(onClose, 1500);
      } catch {
        setStatus({ kind: 'error', text: 'The photo could not be sent. Please try again.' });
      } finally {
        setSending(false);
      }
    }
    // Lets the same file be chosen again after an error.
    input.value = '';
  }

  return (
    <div
      data-testid="photo-fallback"
      className="bg-bg2 border-separator1 dark:border-separator2 absolute inset-x-2 top-2 z-30 rounded-2xl border p-3 text-sm drop-shadow-md"
    >
      <p>Screen sharing isn&apos;t available in this browser. You can send a photo instead.</p>
      <label className="mt-2 block">
        <span className="sr-only">Choose a photo to send</span>
        <input type="file" accept="image/*" disabled={sending} onChange={(e) => void onChange(e)} />
      </label>
      <button type="button" onClick={onClose} className="mt-2 underline">
        Close
      </button>
      {status && (
        <p role={status.kind === 'error' ? 'alert' : 'status'} className="mt-2">
          {status.text}
        </p>
      )}
    </div>
  );
}
