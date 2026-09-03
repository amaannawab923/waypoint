import { useEffect, useState } from 'react';
import { updateWorkspace } from '@/data/api';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useWorkspaceSettings } from '@/pages/workspace-settings/WorkspaceSettingsLayout';

const COMPANY_SIZES = ['Just myself', '2-10', '11-50', '51-200', '200+'];

const TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Africa/Lagos',
  'Africa/Cairo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

const inputClass =
  'h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none focus:border-accent';

const labelClass = 'mb-1.5 block text-sm font-medium text-text';

export default function General() {
  const { workspace, workspaceLoading: loading, reloadWorkspace } = useWorkspaceSettings();
  const [name, setName] = useState('');
  const [companySize, setCompanySize] = useState(COMPANY_SIZES[0]);
  const [timezone, setTimezone] = useState(TIMEZONES[0]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (workspace) {
      setName(workspace.name);
      setCompanySize(workspace.companySize);
      setTimezone(workspace.timezone);
    }
  }, [workspace]);

  async function handleSave() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await updateWorkspace({ name: name.trim(), companySize, timezone });
      reloadWorkspace();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  const dirty = workspace
    ? name !== workspace.name || companySize !== workspace.companySize || timezone !== workspace.timezone
    : false;

  return (
    <div className="max-w-lg">
      <h2 className="mb-6 font-display text-lg font-medium text-text">General</h2>

      {loading && !workspace && (
        <Skeleton className="flex flex-col gap-5">
          <div>
            <Skeleton.Block height="0.875rem" width="8rem" className="mb-1.5" />
            <Skeleton.Block height="2.25rem" />
          </div>
          <div>
            <Skeleton.Block height="0.875rem" width="7rem" className="mb-1.5" />
            <Skeleton.Block height="2.25rem" />
          </div>
          <div>
            <Skeleton.Block height="0.875rem" width="9rem" className="mb-1.5" />
            <Skeleton.Block height="2.25rem" />
          </div>
        </Skeleton>
      )}

      {workspace && (
        <div className="flex flex-col gap-5">
          <div>
            <label className={labelClass} htmlFor="workspace-name">
              Workspace name
            </label>
            <input
              id="workspace-name"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="company-size">
              Company size
            </label>
            <select
              id="company-size"
              className={inputClass}
              value={companySize}
              onChange={(e) => setCompanySize(e.target.value)}
            >
              {COMPANY_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass} htmlFor="timezone">
              Workspace timezone
            </label>
            <select
              id="timezone"
              className={inputClass}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Button variant="primary" disabled={!dirty || saving} onClick={handleSave}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
            {saved && <span className="text-sm text-success">Saved</span>}
          </div>

          <div className="mt-6 rounded-[var(--radius-lg)] border border-danger/30 bg-danger-bg p-5">
            <h3 className="mb-1 font-display text-sm font-medium text-danger">Delete workspace</h3>
            <p className="mb-4 text-sm text-text-secondary">
              When you delete a workspace, all of the data in it — projects, work items, cycles,
              modules, pages, and members — is permanently removed. This action cannot be undone.
            </p>
            <Button variant="danger" disabled title="There's no way to delete a workspace's data yet.">
              Delete workspace
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
