import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line import/named
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ActionBar } from '@/components/embed-popup/action-bar';
import { PhotoFallback } from '@/components/embed-popup/photo-fallback';
import { PHOTO_MAX_BYTES, PHOTO_TOPIC } from '@/lib/screenshare-protocol';

afterEach(cleanup);

function setup(sendFile = vi.fn().mockResolvedValue({ id: 's1' })) {
  const onClose = vi.fn();
  render(<PhotoFallback participant={{ sendFile }} onClose={onClose} />);
  const input = screen.getByLabelText(/choose a photo/i) as HTMLInputElement;
  const pick = (file: File) => fireEvent.change(input, { target: { files: [file] } });
  return { sendFile, input, pick, onClose };
}

vi.mock('@livekit/components-react', () => ({
  BarVisualizer: () => null,
  useRemoteParticipants: () => [{ isAgent: true }],
}));
vi.mock('@/hooks/use-agent-control-bar', () => {
  const t = { enabled: false, pending: false, toggle: () => {} };
  return {
    useAgentControlBar: () => ({
      micTrackRef: undefined,
      visibleControls: { microphone: false, camera: false, screenShare: true, chat: false },
      cameraToggle: t,
      microphoneToggle: t,
      screenShareToggle: t,
      handleAudioDeviceChange: () => {},
      handleVideoDeviceChange: () => {},
    }),
  };
});

describe('ActionBar photo button', () => {
  const caps = { supportsChatInput: false, supportsVideoInput: false, supportsScreenShare: false };
  it('is absent when no photo handler is given (browser can share)', () => {
    render(<ActionBar capabilities={caps} />);
    expect(screen.queryByRole('button', { name: /send a photo/i })).toBeNull();
  });
  it('is present and fires when the browser cannot share', () => {
    const onSendPhoto = vi.fn();
    render(<ActionBar capabilities={caps} onSendPhoto={onSendPhoto} />);
    fireEvent.click(screen.getByRole('button', { name: /send a photo/i }));
    expect(onSendPhoto).toHaveBeenCalledTimes(1);
  });
});

describe('PhotoFallback', () => {
  it('closes via the close control', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes itself shortly after a successful send', async () => {
    const { pick, onClose } = setup();
    pick(new File(['x'], 'a.png', { type: 'image/png' }));
    await screen.findByText('Photo sent.');
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 3000 });
  });

  it('explains and offers an image-only, labelled file input', () => {
    const { input } = setup();
    expect(
      screen.getByText(
        "Screen sharing isn't available in this browser. You can send a photo instead."
      )
    ).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveAttribute('accept', 'image/*');
  });

  it('sends a valid image on the photo topic', async () => {
    const { sendFile, pick } = setup();
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    pick(file);
    await waitFor(() => expect(sendFile).toHaveBeenCalledWith(file, { topic: PHOTO_TOPIC }));
    expect(PHOTO_TOPIC).toBe('telzino.photo');
    expect(await screen.findByText('Photo sent.')).toBeInTheDocument();
  });

  it('rejects an oversize image without sending', () => {
    const { sendFile, pick } = setup();
    const file = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: PHOTO_MAX_BYTES + 1 });
    pick(file);
    expect(screen.getByRole('alert')).toHaveTextContent(/too large/i);
    expect(sendFile).not.toHaveBeenCalled();
  });

  it('accepts exactly the maximum size', async () => {
    const { sendFile, pick } = setup();
    const file = new File(['x'], 'ok.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: PHOTO_MAX_BYTES });
    pick(file);
    await waitFor(() => expect(sendFile).toHaveBeenCalledTimes(1));
  });

  it('rejects a non-image without sending', () => {
    const { sendFile, pick } = setup();
    pick(new File(['x'], 'a.pdf', { type: 'application/pdf' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/image/i);
    expect(sendFile).not.toHaveBeenCalled();
  });

  it('shows an error when the send fails', async () => {
    const { pick } = setup(vi.fn().mockRejectedValue(new Error('boom')));
    pick(new File(['x'], 'a.png', { type: 'image/png' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be sent/i);
  });
});
