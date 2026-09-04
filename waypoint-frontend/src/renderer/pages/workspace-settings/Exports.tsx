import { useState } from 'react';
import { Download } from 'lucide-react';
import { IconRefresh } from '@/components/icons';
import { useAsync } from '@/lib/useAsync';
import { listProjects, listExports, createExport } from '@/data/api';
import { Button, IconButton } from '@/components/ui/Button';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonTableRows } from '@/components/ui/Skeleton';
import { NotWired } from '@/components/ui/NotWired';
import type { ExportStatus } from '@/types/entities';
import { clsx } from 'clsx';

const ALL_PROJECTS = '__all__';

const STATUS_TONE: Record<ExportStatus, BadgeTone> = {
  completed: 'success',
  processing: 'warning',
  failed: 'danger',
};

const STATUS_LABEL: Record<ExportStatus, string> = {
  completed: 'Completed',
  processing: 'Processing',
  failed: 'Failed',
};

export default function Exports() {
  const { data: projects } = useAsync(() => listProjects(), []);
  const { data: exports, loading, reload } = useAsync(() => listExports(), []);
  const [scope, setScope] = useState(ALL_PROJECTS);
  const [format, setFormat] = useState('CSV');
  const [exporting, setExporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function handleExport() {
    if (exporting) return;
    const scopeLabel =
      scope === ALL_PROJECTS ? 'All projects' : (projects ?? []).find((p) => p.id === scope)?.name ?? 'Project';
    setExporting(true);
    try {
      await createExport({ scopeLabel, format });
      reload();
    } finally {
      setExporting(false);
    }
  }

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      reload();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div>
      <h2 className="mb-1 font-display text-lg font-medium text-text">Exports</h2>
      <p className="mb-3 text-sm text-text-secondary">
        Export your workspace data as a downloadable file.
      </p>

      <div className="mb-6">
        <NotWired capability="exports.download" />
      </div>

      <div className="mb-8 flex flex-wrap items-end gap-3 rounded-[var(--radius-lg)] border border-border bg-surface-2 p-4">
        <div className="min-w-[200px]">
          <label className="mb-1.5 block text-sm font-medium text-text" htmlFor="export-scope">
            Scope
          </label>
          <select
            id="export-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
          >
            <option value={ALL_PROJECTS}>All projects</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-text" htmlFor="export-format">
            Format
          </label>
          <select
            id="export-format"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="h-9 w-28 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm outline-none focus:border-accent"
          >
            <option value="CSV">CSV</option>
          </select>
        </div>
        <Button variant="primary" disabled={exporting} onClick={handleExport}>
          <Download size={15} />
          {exporting ? 'Exporting…' : 'Export'}
        </Button>
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-display text-sm font-medium text-text">Previous exports</h3>
        <IconButton label="Refresh exports" onClick={handleRefresh} disabled={refreshing || loading}>
          <IconRefresh size={14} className={clsx((refreshing || loading) && 'animate-spin')} />
        </IconButton>
      </div>

      {loading && !exports && (
        <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border">
          <SkeletonTableRows columns={4} rows={3} />
        </div>
      )}

      {exports && exports.length === 0 && (
        <EmptyState
          icon={<Download size={28} />}
          title="No exports yet"
          description="Exports you run will show up here so you can track and re-download them."
        />
      )}

      {exports && exports.length > 0 && (
        <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2 text-left text-xs text-text-muted">
                <th className="px-4 py-2.5 font-medium">Scope</th>
                <th className="px-4 py-2.5 font-medium">Format</th>
                <th className="px-4 py-2.5 font-medium">Requested</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {exports.map((e) => (
                <tr key={e.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2.5 text-text">{e.scopeLabel}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{e.format}</td>
                  <td className="px-4 py-2.5 text-text-secondary">
                    {new Date(e.createdAt).toLocaleString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
