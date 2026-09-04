import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

/** Electron's renderer doesn't implement window.prompt() at all (unlike
 * window.confirm(), which is real) — any code path relying on it crashes
 * unconditionally. This is the in-app replacement: a small single-field
 * text-prompt modal. Originally local to ProjectViewsPage.tsx (rename/create
 * view); pulled out to components/ui so W5.3's "Save as view" dialog in
 * TicketListToolbar.tsx can reuse it instead of duplicating the same modal. */
export function NamePromptModal({
  open,
  title,
  initialValue,
  confirmLabel,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initialValue: string;
  confirmLabel: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={!value.trim()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none focus:border-accent"
      />
    </Modal>
  );
}
