import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Attachment } from '@/types/entities';
import { AttachmentList } from './AttachmentList';

jest.mock('@/data/api', () => ({
  attachmentUrl: (a: { url: string }) => `https://api.test${a.url}`,
  attachmentDownloadUrl: (a: { downloadUrl: string }) =>
    `https://api.test${a.downloadUrl}`,
}));

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1',
    ticketId: 't1',
    commentId: 'c1',
    uploaderId: 'u1',
    filename: 'diagram.png',
    mimeType: 'image/png',
    sizeBytes: 2048,
    createdAt: '2026-01-01T00:00:00.000Z',
    // Built by the server, signature and all — the client never
    // reconstructs these from `id`. See Attachment.url.
    url: '/attachments/a1?t=exp.sig',
    downloadUrl: '/attachments/a1/download?t=exp.sig',
    ...overrides,
  };
}

describe('AttachmentList', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<AttachmentList attachments={[]} canDelete={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an image as a clickable thumbnail with always-visible download/delete', () => {
    render(<AttachmentList attachments={[attachment()]} canDelete />);
    expect(screen.getByRole('button', { name: 'Open diagram.png' })).toBeInTheDocument();
    const download = screen.getByRole('link', { name: 'Download diagram.png' });
    // The signature is part of the URL, not decoration: without it a plain
    // browser request has no way to authorize itself on a hosted instance.
    expect(download).toHaveAttribute(
      'href',
      'https://api.test/attachments/a1/download?t=exp.sig',
    );
    expect(screen.getByRole('button', { name: 'Delete diagram.png' })).toBeInTheDocument();
  });

  it('hides delete when canDelete is false, but keeps download', () => {
    render(<AttachmentList attachments={[attachment()]} canDelete={false} />);
    expect(screen.getByRole('link', { name: 'Download diagram.png' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete diagram.png' })).not.toBeInTheDocument();
  });

  it('calls onDelete with the attachment when Delete is clicked', () => {
    const onDelete = jest.fn();
    const a = attachment();
    render(<AttachmentList attachments={[a]} canDelete onDelete={onDelete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete diagram.png' }));
    expect(onDelete).toHaveBeenCalledWith(a);
  });

  it('renders a non-image as a labelled row rather than a thumbnail', () => {
    render(
      <AttachmentList
        attachments={[attachment({ id: 'a2', filename: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 4096 })]}
        canDelete={false}
      />,
    );
    expect(screen.getByText('notes.pdf')).toBeInTheDocument();
    expect(screen.getByText(/PDF · 4 KB/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open notes.pdf' })).not.toBeInTheDocument();
  });

  it('opens the lightbox on an image click, scoped to only the images in the list', () => {
    render(
      <AttachmentList
        attachments={[
          attachment({ id: 'img1', filename: 'one.png' }),
          attachment({ id: 'doc1', filename: 'doc.pdf', mimeType: 'application/pdf' }),
          attachment({ id: 'img2', filename: 'two.png' }),
        ]}
        canDelete={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open two.png' }));
    const dialog = screen.getByRole('dialog');
    // "two.png" is the second image overall but the SECOND of the two
    // images (the pdf isn't part of the navigable set) — must open at
    // index 2 of 2, not 3 of 3.
    expect(dialog).toHaveAccessibleName(expect.stringContaining('2 of 2'));
  });

  it('shows a 0-byte attachment size honestly', () => {
    render(
      <AttachmentList
        attachments={[attachment({ id: 'a3', filename: 'empty.png', sizeBytes: 0 })]}
        canDelete={false}
      />,
    );
    expect(screen.getByText('0 B')).toBeInTheDocument();
  });

  it('falls back to a broken-image placeholder when an image 404s, without crashing', () => {
    render(<AttachmentList attachments={[attachment()]} canDelete={false} />);
    const img = document.querySelector('img') as HTMLImageElement;
    fireEvent.error(img);
    // The thumbnail button is still there and still opens the lightbox —
    // a 404'd image degrades, it doesn't disappear.
    expect(screen.getByRole('button', { name: 'Open diagram.png' })).toBeInTheDocument();
  });
});
