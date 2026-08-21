import { useState } from 'react';
import { Plus, Pencil } from 'lucide-react';
import { Button, IconButton } from '@/components/ui/Button';
import { Dot } from '@/components/ui/Badge';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { STATE_GROUP_LABEL, STATE_GROUP_ORDER } from '@/components/domain/StateIcon';
import { useAsync } from '@/lib/useAsync';
import { useProject } from '@/layouts/ProjectLayout';
import { createState, updateState, deleteState, countWorkItemsInState, listStates } from '@/mock/api';
import type { StateGroup, WorkItemState } from '@/types/entities';

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

function StateEditor({
  state,
  onSaved,
  onDeleted,
  onCancel,
}: {
  state: WorkItemState;
  onSaved: () => void;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(state.name);
  const [color, setColor] = useState(state.color);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The server rejects deleting a state that any work item still
  // references (work_items.state_id is `onDelete: 'restrict'`, no
  // reassignment happens) — fetched upfront so the delete control can
  // reflect that up front rather than let the user reach a confirm step
  // for a delete that's guaranteed to fail.
  const { data: usageCount } = useAsync(() => countWorkItemsInState(state.id), [state.id]);

  async function handleSave() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await updateState(state.id, { name: name.trim(), color });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteClick() {
    if (deleting || usageCount) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await deleteState(state.id);
      onDeleted();
    } catch {
      // httpClient already surfaced a toast for the failure; just leave
      // the confirm step in place so the user can retry rather than lose
      // their place.
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex gap-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-9 flex-1 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
        />
      </div>
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
      {!!usageCount && (
        <p className="text-xs text-text-muted">
          {usageCount} work item{usageCount === 1 ? '' : 's'} use this state, so it can't be deleted. Move them
          to another state first.
        </p>
      )}
      {confirmDelete && !usageCount && (
        <p className="text-xs text-danger">This can't be undone. Click delete again to confirm.</p>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button
          variant={confirmDelete ? 'danger' : 'ghost'}
          size="sm"
          onClick={handleDeleteClick}
          disabled={deleting || state.isDefault || !!usageCount}
          title={
            state.isDefault
              ? 'Default states cannot be deleted'
              : usageCount
                ? `${usageCount} work item${usageCount === 1 ? '' : 's'} still use this state`
                : undefined
          }
        >
          {deleting ? 'Deleting…' : confirmDelete ? 'Confirm delete' : 'Delete'}
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving || deleting}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!name.trim() || saving} onClick={handleSave}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function States() {
  const { project } = useProject();
  const { data: states, loading, reload } = useAsync(() => listStates(project.id), [project.id]);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [group, setGroup] = useState<StateGroup>('unstarted');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function handleCreate() {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      await createState(project.id, { name: name.trim(), group, color });
      setName('');
      setColor(PRESET_COLORS[0]);
      setShowForm(false);
      reload();
    } finally {
      setSubmitting(false);
    }
  }

  const grouped = STATE_GROUP_ORDER.map((g) => ({
    group: g,
    states: (states ?? []).filter((s) => s.group === g),
  }));

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-lg font-medium text-text">States</h1>
          <p className="mt-1 text-sm text-text-secondary">Manage the workflow states work items move through.</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowForm((v) => !v)}>
          <Plus size={14} />
          Add state
        </Button>
      </div>

      {showForm && (
        <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-border-strong p-4">
          <div className="flex gap-2">
            <input
              autoFocus
              placeholder="State name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 flex-1 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
            />
            <select
              value={group}
              onChange={(e) => setGroup(e.target.value as StateGroup)}
              className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2 text-sm outline-none focus:border-accent"
            >
              {STATE_GROUP_ORDER.map((g) => (
                <option key={g} value={g}>
                  {STATE_GROUP_LABEL[g]}
                </option>
              ))}
            </select>
          </div>
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
              {submitting ? 'Adding…' : 'Add state'}
            </Button>
          </div>
        </div>
      )}

      {loading && !states ? (
        <div className="rounded-[var(--radius)] border border-border">
          <SkeletonListRows rows={5} />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.map(({ group: g, states: groupStates }) => (
            <div key={g} className="flex flex-col gap-2">
              <div className="text-xs font-medium tracking-wide text-text-muted uppercase">
                {STATE_GROUP_LABEL[g]}
              </div>
              {groupStates.length === 0 ? (
                <p className="px-1 text-sm text-text-muted">No states in this group.</p>
              ) : (
                <div className="flex flex-col divide-y divide-border rounded-[var(--radius)] border border-border">
                  {groupStates.map((state) =>
                    editingId === state.id ? (
                      <StateEditor
                        key={state.id}
                        state={state}
                        onSaved={() => {
                          setEditingId(null);
                          reload();
                        }}
                        onDeleted={() => {
                          setEditingId(null);
                          reload();
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : (
                      <button
                        key={state.id}
                        type="button"
                        onClick={() => setEditingId(state.id)}
                        className="group flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-surface-2"
                      >
                        <Dot color={state.color} />
                        <span className="text-sm text-text">{state.name}</span>
                        <div className="ml-auto flex items-center gap-2">
                          {state.isDefault && <span className="text-xs text-text-muted">Default</span>}
                          <IconButton
                            label="Edit state"
                            className="opacity-0 group-hover:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingId(state.id);
                            }}
                          >
                            <Pencil size={13} />
                          </IconButton>
                        </div>
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
