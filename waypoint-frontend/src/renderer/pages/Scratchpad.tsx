import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { IconPlus, IconEdit, IconScratch } from '@/components/icons';
import { useAsync } from '@/lib/useAsync';
import { listScratchNotes, createScratchNote, deleteScratchNote } from '@/data/api';
import type { ScratchNote } from '@/types/entities';
import { Button, IconButton } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { NotWired } from '@/components/ui/NotWired';

const NOTE_TITLE_WIDTHS = ['w-24', 'w-32', 'w-20'];

function NoteModal({
  open,
  onClose,
  onSaved,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  editing: ScratchNote | null;
}) {
  const [title, setTitle] = useState(editing?.title ?? '');
  const [body, setBody] = useState(editing?.body ?? '');
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setTitle(editing?.title ?? '');
    setBody(editing?.body ?? '');
  }

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      if (editing) {
        // No update endpoint for scratch notes — replace in place.
        await deleteScratchNote(editing.id);
      }
      await createScratchNote(title.trim() || 'Untitled', body.trim());
      onSaved();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={editing ? 'Edit note' : 'New note'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={submitting} onClick={handleSubmit}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {editing && <NotWired capability="scratchpad.editing" />}
        <input
          autoFocus
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
        />
        <textarea
          placeholder="Write a note…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          className="resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </div>
    </Modal>
  );
}

export default function Scratchpad() {
  const { data: notes, loading, reload } = useAsync(() => listScratchNotes(), []);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ScratchNote | null>(null);

  function openCreate() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(note: ScratchNote) {
    setEditing(note);
    setModalOpen(true);
  }

  async function handleDelete(id: string) {
    await deleteScratchNote(id);
    reload();
  }

  return (
    <div className="mx-auto max-w-5xl p-6 md:p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-medium text-text">Scratchpad</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Yours and unfiled — quick thoughts that don't belong to a project yet.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate}>
          <IconPlus size={15} />
          New note
        </Button>
      </div>

      <div className="mt-6">
        {loading && !notes ? (
          <Skeleton className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="flex min-h-[150px] flex-col gap-3 rounded-[var(--radius)] border border-border bg-surface p-4"
              >
                <Skeleton.Block height="0.875rem" className={NOTE_TITLE_WIDTHS[index % NOTE_TITLE_WIDTHS.length]} />
                <Skeleton.Block height="0.75rem" width="90%" />
                <Skeleton.Block height="0.75rem" width="70%" />
                <Skeleton.Block height="0.75rem" width="50%" />
              </div>
            ))}
          </Skeleton>
        ) : notes && notes.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {notes.map((note) => (
              <div
                key={note.id}
                className="group flex min-h-[150px] flex-col gap-2 rounded-[var(--radius)] border border-border bg-surface p-4"
                style={{ borderLeft: `4px solid ${note.color}` }}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 truncate font-display text-sm font-medium text-text">
                    {note.title || 'Untitled'}
                  </p>
                  <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <IconButton label="Edit note" onClick={() => openEdit(note)}>
                      <IconEdit size={14} />
                    </IconButton>
                    <IconButton label="Delete note" onClick={() => handleDelete(note.id)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </div>
                <p className="flex-1 line-clamp-6 text-sm whitespace-pre-wrap text-text-secondary">{note.body}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<IconScratch size={28} />}
            title="Nothing on the scratchpad yet"
            description="Scratchpad is personal and unfiled. Docs live inside a project and are shared with its members."
            action={
              <Button variant="secondary" onClick={openCreate}>
                <IconPlus size={15} />
                New note
              </Button>
            }
          />
        )}
      </div>

      <NoteModal
        key={editing?.id ?? 'new'}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={reload}
        editing={editing}
      />
    </div>
  );
}
