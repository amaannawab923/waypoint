import { useRef, useState } from 'react';
import { Tag, Trash2 } from 'lucide-react';
import { IconPlus, IconEdit } from '@/components/icons';
import { Button, IconButton } from '@/components/ui/Button';
import { Badge, Dot } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { useAsync } from '@/lib/useAsync';
import { useProject } from '@/layouts/ProjectLayout';
import { createLabel, updateLabel, deleteLabel, listLabels } from '@/data/api';
import type { Label } from '@/types/entities';

const PRESET_COLORS = [
  '#c2542a',
  '#9c9280',
  '#7d8a9c',
  '#c99a2e',
  '#2f7a4f',
  '#b7332a',
  '#6b6050',
  '#2f6fa8',
];

function LabelEditor({ label, onSaved, onCancel }: { label: Label; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);
  const [saving, setSaving] = useState(false);
  // Same fix as CopilotProposalCard.tsx's act(): "Save" disables itself
  // (saving) while the POST is in flight, and onSaved unmounts this whole
  // editor on success — either path force-blurs to <body> and leaks the
  // next keystroke to useGlobalKeyboardShortcuts.ts's global nav
  // shortcuts. This editor's own root is the stable container neither
  // path touches.
  const editorRef = useRef<HTMLDivElement>(null);

  async function handleSave() {
    if (!name.trim() || saving) return;
    editorRef.current?.focus();
    setSaving(true);
    try {
      await updateLabel(label.id, { name: name.trim(), color });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={editorRef}
      tabIndex={-1}
      data-shortcut-guard
      className="flex flex-col gap-3 rounded-[var(--radius-sm)] border border-border-strong bg-surface p-3 outline-none"
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
      />
      <div className="flex items-center gap-1.5">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            className={
              'size-6 rounded-full transition-transform ' +
              (color === c ? 'scale-110 ring-2 ring-offset-2 ring-offset-surface ring-accent' : '')
            }
            style={{ background: c }}
            aria-label={c}
          />
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!name.trim() || saving} onClick={handleSave}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

export default function Labels() {
  const { project } = useProject();
  const { data: labels, loading, reload } = useAsync(() => listLabels(project.id), [project.id]);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Same fix as CopilotProposalCard.tsx's act(), applied at two more
  // sites in this component: "Add label" disables itself (submitting)
  // and unmounts this form (setShowForm(false)) on success; "Confirm"
  // delete disables itself (deletingId) and, once `reload()` drops the
  // deleted label from `labels`, unmounts its own row. Both force-blur to
  // <body> and leak the next keystroke to useGlobalKeyboardShortcuts.ts's
  // global nav shortcuts.
  const createFormRef = useRef<HTMLDivElement>(null);
  // Delete lives per-row, so each label's row needs its own focus target
  // — a ref Map keyed by label id, same shape as any keyed-list ref map.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  async function handleCreate() {
    if (!name.trim() || submitting) return;
    createFormRef.current?.focus();
    setSubmitting(true);
    try {
      await createLabel(project.id, { name: name.trim(), color });
      setName('');
      setColor(PRESET_COLORS[0]);
      setShowForm(false);
      reload();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (deletingId) return;
    rowRefs.current.get(id)?.focus();
    setDeletingId(id);
    try {
      await deleteLabel(id);
      setConfirmDeleteId(null);
      reload();
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-lg font-medium text-text">Labels</h1>
          <p className="mt-1 text-sm text-text-secondary">Manage labels used to categorize tickets.</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowForm((v) => !v)}>
          <IconPlus size={14} />
          Add label
        </Button>
      </div>

      {showForm && (
        <div
          ref={createFormRef}
          tabIndex={-1}
          data-shortcut-guard
          className="flex flex-col gap-3 rounded-[var(--radius)] border border-border-strong p-4 outline-none"
        >
          <input
            autoFocus
            placeholder="Label name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
          />
          <div className="flex items-center gap-1.5">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={
                  'size-6 rounded-full transition-transform ' +
                  (color === c ? 'scale-110 ring-2 ring-offset-2 ring-offset-surface ring-accent' : '')
                }
                style={{ background: c }}
                aria-label={c}
              />
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" disabled={!name.trim() || submitting} onClick={handleCreate}>
              {submitting ? 'Adding…' : 'Add label'}
            </Button>
          </div>
        </div>
      )}

      {loading && !labels ? (
        <div className="rounded-[var(--radius)] border border-border-strong">
          <SkeletonListRows rows={4} />
        </div>
      ) : (labels ?? []).length === 0 ? (
        <EmptyState icon={<Tag size={28} />} title="No labels yet" description="Add labels to categorize tickets." />
      ) : (
        <div className="flex flex-col gap-2">
          {(labels ?? []).map((label) =>
            editingId === label.id ? (
              <LabelEditor
                key={label.id}
                label={label}
                onSaved={() => {
                  setEditingId(null);
                  reload();
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <div
                key={label.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(label.id, el);
                  else rowRefs.current.delete(label.id);
                }}
                tabIndex={-1}
                data-shortcut-guard
                className="group flex items-center gap-2 rounded-[var(--radius-sm)] border border-border-strong px-3 py-1.5 outline-none"
              >
                <Badge outline className="border-0 px-0">
                  <Dot color={label.color} />
                  {label.name}
                </Badge>
                <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100">
                  <IconButton label="Edit label" onClick={() => setEditingId(label.id)}>
                    <IconEdit size={13} />
                  </IconButton>
                  {confirmDeleteId === label.id ? (
                    <Button
                      variant="danger"
                      size="xs"
                      disabled={deletingId === label.id}
                      onClick={() => handleDelete(label.id)}
                    >
                      {deletingId === label.id ? 'Deleting…' : 'Confirm'}
                    </Button>
                  ) : (
                    <IconButton label="Delete label" onClick={() => setConfirmDeleteId(label.id)}>
                      <Trash2 size={13} />
                    </IconButton>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
