import { useEffect, useState } from 'react';
import { getWorkspace, updateWorkspace } from '@/data/api';
import {
  SESSION_PROVIDER_IDS,
  SESSION_PROVIDERS,
  workspaceDefaultProvider,
} from '@/lib/sessionProviders';
import { showErrorToast } from '@/lib/toast';
import type { SupportedProviderId } from '@/types/agentRuns';

/**
 * Settings → Agents: the workspace's default provider (W4; emdash's
 * `defaultAgent`, adopted). Every new session preselects it — the New
 * session dialog, and W5's dispatch from a ticket — and a person can pick
 * another for one session in the dialog. Saved on change: one field, one
 * write, the way the sidebar pin is remembered, not a form with a Save
 * button (there is nothing else to save with it).
 */
export function DefaultProviderSetting() {
  const [value, setValue] = useState<SupportedProviderId | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      let stored: string | null = null;
      try {
        stored = (await getWorkspace()).defaultAgentProvider;
      } catch {
        // Unreadable: the built-in default is shown, and a change still saves.
      }
      if (!cancelled) setValue(workspaceDefaultProvider(stored));
    };
    read().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const change = async (next: SupportedProviderId) => {
    const previous = value;
    setValue(next);
    setSaving(true);
    try {
      await updateWorkspace({ defaultAgentProvider: next });
    } catch (error) {
      setValue(previous);
      showErrorToast(
        error instanceof Error
          ? error.message
          : 'The default provider was not saved.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      data-default-provider
      className="rounded-[var(--radius-lg)] border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text">Default provider</h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            Every new session runs on this provider unless the person starting
            it picks another. A session keeps its provider for life.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <span className="sr-only">Default provider</span>
          <select
            aria-label="Default provider"
            value={value ?? ''}
            disabled={value === null || saving}
            onChange={(e) => {
              change(e.target.value as SupportedProviderId).catch(() => {});
            }}
            className="h-8 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-2.5 text-sm text-text outline-none focus:border-accent disabled:opacity-60"
          >
            {value === null && <option value="">Loading…</option>}
            {SESSION_PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {SESSION_PROVIDERS[id].name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
