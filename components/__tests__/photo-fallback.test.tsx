import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line import/named
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PhotoFallback } from '@/components/embed-popup/photo-fallback';
import { PHOTO_MAX_BYTES, PHOTO_TOPIC } from '@/lib/screenshare-protocol';

afterEach(cleanup);

function setup(sendFile = vi.fn().mockResolvedValue({ id: 's1' })) {
  render(<PhotoFallback participant={{ sendFile }} />);
  const input = screen.getByLabelText(/choose a photo/i) as HTMLInputElement;
  const pick = (file: File) => fireEvent.change(input, { target: { files: [file] } });
  return { sendFile, input, pick };
}

describe('PhotoFallback', () => {
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
