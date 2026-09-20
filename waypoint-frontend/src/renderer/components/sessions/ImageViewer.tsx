import { Modal } from '@/components/ui/Modal';

/**
 * The image a transcript row was clicked on — a screenshot a session took
 * while verifying (chat-ui's `onViewImage`, source 'tool'), or one the
 * person attached to a message — at its natural size, scrollable when
 * taller than the window. chat-ui hands over the data URL; nothing is
 * fetched.
 */
export function ImageViewer({
  image,
  onClose,
}: {
  image: { name: string; dataUrl: string } | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={image !== null}
      onClose={onClose}
      title={image?.name ?? ''}
      width={1100}
    >
      {image && (
        <div
          className="thin-scroll max-h-[75vh] overflow-auto"
          data-image-viewer
        >
          <img
            src={image.dataUrl}
            alt={image.name}
            className="block h-auto max-w-full rounded-[var(--radius-sm)] border border-border"
          />
        </div>
      )}
    </Modal>
  );
}
