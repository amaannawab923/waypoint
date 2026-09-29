import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { AttachmentTray, type UploadItem } from './AttachmentTray';

jest.mock('@/data/api', () => ({
  attachmentUrl: (id: string) => `https://api.test/attachments/${id}`,
}));

// jsdom doesn't implement the Blob URL API at all — polyfilled here purely
// so the component's createObjectURL/revokeObjectURL calls don't throw.
// revokeSpy lets a couple of tests assert the "revoke on unmount" cleanup
// this component exists to guarantee (see AttachmentTray.tsx's own comment
// about leaking memory on every screenshot paste).
let objectUrlCounter = 0;
const revokeSpy = jest.fn();
beforeAll(() => {
  URL.createObjectURL = jest.fn(() => `blob:test-${(objectUrlCounter += 1)}`);
  URL.revokeObjectURL = revokeSpy;
});
beforeEach(() => {
  revokeSpy.mockClear();
});

function item(overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    key: 'k1',
    file: new File(['bytes'], 'screenshot.png', { type: 'image/png' }),
    progress: 0,
    status: 'uploading',
    ...overrides,
  };
}

describe('AttachmentTray', () => {
  it('renders nothing when there are no items', () => {
    const { container } = render(<AttachmentTray items={[]} onRetry={jest.fn()} onRemove={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a determinate progress bar while uploading', () => {
    render(<AttachmentTray items={[item({ progress: 0.42 })]} onRetry={jest.fn()} onRemove={jest.fn()} />);
    const bar = screen.getByRole('progressbar', { name: 'Uploading screenshot.png' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
  });

  it('cancels an in-progress upload via the Cancel chip', () => {
    const onRemove = jest.fn();
    render(<AttachmentTray items={[item()]} onRetry={jest.fn()} onRemove={onRemove} />);
    screen.getByRole('button', { name: 'Cancel uploading screenshot.png' }).click();
    expect(onRemove).toHaveBeenCalledWith('k1');
  });

  it('shows the error message and a Retry chip on a failed upload', () => {
    const onRetry = jest.fn();
    render(
      <AttachmentTray
        items={[item({ status: 'error', error: 'Network error', progress: 0.3 })]}
        onRetry={onRetry}
        onRemove={jest.fn()}
      />,
    );
    expect(screen.getByText('Network error')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Retry uploading screenshot.png' }).click();
    expect(onRetry).toHaveBeenCalledWith('k1');
    // A failed item's removal action reads "Remove", not "Cancel" — it isn't
    // mid-flight any more.
    expect(screen.getByRole('button', { name: 'Remove screenshot.png' })).toBeInTheDocument();
  });

  it('shows a distinct message for an aborted (canceled) upload', () => {
    render(
      <AttachmentTray items={[item({ status: 'aborted' })]} onRetry={jest.fn()} onRemove={jest.fn()} />,
    );
    expect(screen.getByText('Canceled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry uploading screenshot.png' })).toBeInTheDocument();
  });

  it('removes a completed upload via the Remove chip, with no progress bar or error shown', () => {
    const onRemove = jest.fn();
    render(
      <AttachmentTray
        items={[item({ status: 'done', progress: 1, attachment: { id: 'a1', ticketId: 't1', commentId: null, uploaderId: 'u1', filename: 'screenshot.png', mimeType: 'image/png', sizeBytes: 1024, createdAt: '2026-01-01T00:00:00.000Z', url: '/attachments/a1?t=exp.sig', downloadUrl: '/attachments/a1/download?t=exp.sig' } })]}
        onRetry={jest.fn()}
        onRemove={onRemove}
      />,
    );
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    screen.getByRole('button', { name: 'Remove screenshot.png' }).click();
    expect(onRemove).toHaveBeenCalledWith('k1');
  });

  it('shows a 0-byte file size honestly rather than blank or NaN', () => {
    render(
      <AttachmentTray
        items={[item({ file: new File([], 'empty.txt', { type: 'text/plain' }) })]}
        onRetry={jest.fn()}
        onRemove={jest.fn()}
      />,
    );
    expect(screen.getByText('0 B')).toBeInTheDocument();
  });

  it('shows an extension badge (not a broken image) for a non-image file', () => {
    render(
      <AttachmentTray
        items={[item({ file: new File(['x'], 'README', { type: 'text/plain' }) })]}
        onRetry={jest.fn()}
        onRemove={jest.fn()}
      />,
    );
    expect(screen.getByText('FILE')).toBeInTheDocument();
  });

  it('revokes the local preview object URL on unmount', () => {
    const { unmount } = render(<AttachmentTray items={[item()]} onRetry={jest.fn()} onRemove={jest.fn()} />);
    expect(revokeSpy).not.toHaveBeenCalled();
    unmount();
    expect(revokeSpy).toHaveBeenCalledTimes(1);
  });

  it('renders many items without erroring, in a scrollable strip', () => {
    const items = Array.from({ length: 50 }, (_, i) => item({ key: `k${i}`, file: new File(['x'], `file-${i}.png`, { type: 'image/png' }) }));
    render(<AttachmentTray items={items} onRetry={jest.fn()} onRemove={jest.fn()} />);
    expect(screen.getAllByRole('button', { name: /^Cancel uploading/ })).toHaveLength(50);
  });
});
