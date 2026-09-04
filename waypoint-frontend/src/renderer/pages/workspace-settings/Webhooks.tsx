import { useState } from 'react';
import { Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { IconPlus } from '@/components/icons';
import { useAsync } from '@/lib/useAsync';
import { listWebhooks, createWebhook, deleteWebhook } from '@/data/api';
import type { WebhookEventType } from '@/types/entities';
import { Button, IconButton } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { SkeletonListRows } from '@/components/ui/Skeleton';
import { NotWired } from '@/components/ui/NotWired';

const EVENT_TYPES: { value: WebhookEventType; label: string }[] = [
  { value: 'ticket.created', label: 'Ticket created' },
  { value: 'ticket.updated', label: 'Ticket updated' },
  { value: 'ticket.deleted', label: 'Ticket deleted' },
  { value: 'project.created', label: 'Project created' },
  { value: 'sprint.created', label: 'Sprint created' },
  { value: 'workstream.created', label: 'Workstream created' },
];

function toggleInArray<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function Webhooks() {
  const { data: webhooks, loading, reload } = useAsync(() => listWebhooks(), []);
  const [addOpen, setAddOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [eventTypes, setEventTypes] = useState<WebhookEventType[]>([]);
  const [submitting, setSubmitting] = useState(false);

  function resetForm() {
    setUrl('');
    setEventTypes([]);
  }

  async function handleCreate() {
    if (!url.trim() || eventTypes.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await createWebhook({ url: url.trim(), eventTypes });
      resetForm();
      setAddOpen(false);
      reload();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    await deleteWebhook(id);
    reload();
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-medium text-text">Webhooks</h2>
          <p className="text-sm text-text-secondary">
            Send an HTTP POST to an external URL whenever selected events happen in this workspace.
          </p>
        </div>
        <Button variant="primary" onClick={() => setAddOpen(true)}>
          <IconPlus size={15} />
          Add webhook
        </Button>
      </div>

      <div className="mb-6">
        <NotWired capability="webhooks.delivery" />
      </div>

      {loading && !webhooks && <SkeletonListRows rows={3} />}

      {webhooks && webhooks.length === 0 && (
        <EmptyState
          icon={<WebhookIcon size={28} />}
          title="No webhooks yet"
          description="Add a webhook to notify an external service when tickets, projects, sprints, or workstreams change."
          action={
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <IconPlus size={15} />
              Add webhook
            </Button>
          }
        />
      )}

      {webhooks && webhooks.length > 0 && (
        <div className="flex flex-col gap-3">
          {webhooks.map((w) => (
            <div
              key={w.id}
              className="flex items-start justify-between gap-4 rounded-[var(--radius-lg)] border border-border bg-surface p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-mono text-sm text-text">{w.url}</p>
                  <Badge tone={w.enabled ? 'success' : 'neutral'}>{w.enabled ? 'Active' : 'Disabled'}</Badge>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {w.eventTypes.map((et) => (
                    <Badge key={et} tone="neutral" outline>
                      {et}
                    </Badge>
                  ))}
                </div>
                <p className="mt-2 text-xs text-text-muted">Added {formatDate(w.createdAt)}</p>
              </div>
              <IconButton label="Delete webhook" onClick={() => handleDelete(w.id)}>
                <Trash2 size={14} />
              </IconButton>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={addOpen}
        onClose={() => {
          resetForm();
          setAddOpen(false);
        }}
        title="Add webhook"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!url.trim() || eventTypes.length === 0 || submitting} onClick={handleCreate}>
              {submitting ? 'Adding…' : 'Add webhook'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text" htmlFor="webhook-url">
              Endpoint URL
            </label>
            <input
              id="webhook-url"
              autoFocus
              type="url"
              placeholder="https://example.com/webhooks/waypoint"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
            />
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium text-text">Events to send</p>
            <div className="flex flex-col gap-0.5 rounded-[var(--radius-sm)] border border-border p-1">
              {EVENT_TYPES.map((et) => (
                <label
                  key={et.value}
                  className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-sm hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={eventTypes.includes(et.value)}
                    onChange={() => setEventTypes((f) => toggleInArray(f, et.value))}
                  />
                  {et.label}
                </label>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
