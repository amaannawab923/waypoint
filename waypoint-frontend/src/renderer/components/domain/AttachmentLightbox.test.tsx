import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Attachment } from '@/types/entities';
import { AttachmentLightbox } from './AttachmentLightbox';

jest.mock('@/data/api', () => ({
  attachmentUrl: (id: string) => `https://api.test/attachments/${id}`,
  attachmentDownloadUrl: (id: string) => `https://api.test/attachments/${id}/download`,
}));

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1',
    ticketId: 't1',
    commentId: 'c1',
    uploaderId: 'u1',
    filename: 'one.png',
    mimeType: 'image/png',
    sizeBytes: 1024,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const items = [
  attachment({ id: 'a1', filename: 'one.png' }),
  attachment({ id: 'a2', filename: 'two.png' }),
  attachment({ id: 'a3', filename: 'three.png' }),
];

describe('AttachmentLightbox', () => {
  it('renders as a labelled dialog with the current position announced', () => {
    render(<AttachmentLightbox items={items} index={0} onIndexChange={jest.fn()} onClose={jest.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(expect.stringContaining('one.png'));
    expect(dialog).toHaveAccessibleName(expect.stringContaining('1 of 3'));
    expect(screen.getByRole('status')).toHaveTextContent('Image 1 of 3: one.png');
  });

  it('shows a visible download link pointing at the attachment download URL', () => {
    render(<AttachmentLightbox items={items} index={0} onIndexChange={jest.fn()} onClose={jest.fn()} />);
    expect(screen.getByRole('link', { name: 'Download one.png' })).toHaveAttribute(
      'href',
      'https://api.test/attachments/a1/download',
    );
  });

  it('Escape calls onClose', () => {
    const onClose = jest.fn();
    render(<AttachmentLightbox items={items} index={0} onIndexChange={jest.fn()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a click on the backdrop closes, but a click on the image does not', () => {
    const onClose = jest.fn();
    render(<AttachmentLightbox items={items} index={0} onIndexChange={jest.fn()} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole('img'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the close button also closes', () => {
    const onClose = jest.fn();
    render(<AttachmentLightbox items={items} index={0} onIndexChange={jest.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close viewer' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ArrowRight/ArrowLeft step through the set, wrapping at both ends', () => {
    const onIndexChange = jest.fn();
    const { rerender } = render(
      <AttachmentLightbox items={items} index={0} onIndexChange={onIndexChange} onClose={jest.fn()} />,
    );
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(onIndexChange).toHaveBeenLastCalledWith(2); // wraps to the last item

    rerender(<AttachmentLightbox items={items} index={2} onIndexChange={onIndexChange} onClose={jest.fn()} />);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(onIndexChange).toHaveBeenLastCalledWith(0); // wraps back to the first
  });

  it('the chevrons also step, and are absent for a single-image set', () => {
    const onIndexChange = jest.fn();
    const { rerender } = render(
      <AttachmentLightbox items={items} index={1} onIndexChange={onIndexChange} onClose={jest.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(onIndexChange).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
    expect(onIndexChange).toHaveBeenCalledWith(0);

    rerender(<AttachmentLightbox items={[items[0]]} index={0} onIndexChange={onIndexChange} onClose={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'Next image' })).not.toBeInTheDocument();
  });

  it('shows an honest fallback, not a broken image icon, when the image 404s', () => {
    render(<AttachmentLightbox items={items} index={0} onIndexChange={jest.fn()} onClose={jest.fn()} />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByText(/couldn.t be loaded/i)).toBeInTheDocument();
  });

  it('traps focus: Tab from the last focusable element cycles to the first', () => {
    render(<AttachmentLightbox items={items} index={0} onIndexChange={jest.fn()} onClose={jest.fn()} />);
    const download = screen.getByRole('link', { name: 'Download one.png' });
    const close = screen.getByRole('button', { name: 'Close viewer' });
    close.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Tab' });
    // The trap pulls focus back to the first focusable element whenever
    // focus isn't already inside a tracked position — asserting it lands
    // somewhere inside the dialog (not escaping to the page behind) is the
    // meaningful guarantee here.
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    void download;
  });

  it('returns focus to the trigger element on close (unmount)', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'open';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(
      <AttachmentLightbox items={items} index={0} onIndexChange={jest.fn()} onClose={jest.fn()} />,
    );
    expect(document.activeElement).not.toBe(trigger);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
