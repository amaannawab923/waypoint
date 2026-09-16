import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  listMyWorkspaces,
  setActiveWorkspace,
  type HostedWorkspace,
} from '@/data/hostedWorkspace';
import { TeamWorkspaceDialog } from '@/components/settings/TeamWorkspaceDialog';

/** AT12 (ROAD-147). The minimal workspace switcher named in the plan —
 * functional, not the mockup's sidebar-footer treatment (a named
 * follow-up). Lives in workspace-settings/General.tsx since that's
 * already this app's one page for "workspace-level" settings, even
 * though the hosted Team workspace concept it switches between is
 * unrelated to the local Personal workspace fields the rest of that page
 * edits. */
export function HostedWorkspaceSwitcher() {
  const [connected, setConnected] = useState(false);
  const [workspaces, setWorkspaces] = useState<HostedWorkspace[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const status = await window.electron.account.status();
      setConnected(status.connected);
      setActiveId(status.identity?.activeWorkspaceId ?? null);
      setWorkspaces(status.connected ? await listMyWorkspaces() : null);
    } catch {
      setWorkspaces(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSwitch(workspaceId: string) {
    setSwitchingId(workspaceId);
    const ok = await setActiveWorkspace(workspaceId);
    if (ok) setActiveId(workspaceId);
    setSwitchingId(null);
  }

  return (
    <div className="mt-6 rounded-[var(--radius-lg)] border border-border bg-surface p-5">
      <h3 className="mb-1 font-display text-sm font-medium text-text">
        Team workspaces
      </h3>
      <p className="mb-4 text-sm text-text-secondary">
        Switch between the hosted team workspaces you belong to, or create a new
        one.
      </p>

      {loading && (
        <Skeleton className="flex flex-col gap-2">
          <Skeleton.Block height="2.5rem" />
          <Skeleton.Block height="2.5rem" />
        </Skeleton>
      )}

      {!loading && !connected && (
        <p className="text-sm text-text-secondary">
          Not signed in to a hosted account yet.
        </p>
      )}

      {!loading && connected && workspaces && workspaces.length === 0 && (
        <p className="text-sm text-text-secondary">
          You don't belong to any team workspaces yet.
        </p>
      )}

      {!loading && connected && workspaces && workspaces.length > 0 && (
        <ul className="flex flex-col gap-2">
          {workspaces.map((ws) => (
            <li
              key={ws.id}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-border-strong px-3 py-2"
            >
              <div>
                <p className="text-sm font-medium text-text">{ws.name}</p>
                <p className="text-xs text-text-secondary capitalize">
                  {ws.myRole}
                </p>
              </div>
              {ws.id === activeId ? (
                <span className="text-xs font-medium text-accent">Active</span>
              ) : (
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={switchingId === ws.id}
                  onClick={() => handleSwitch(ws.id)}
                >
                  {switchingId === ws.id ? 'Switching…' : 'Switch'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setCreateOpen(true)}
        >
          Create team workspace
        </Button>
      </div>

      <TeamWorkspaceDialog
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
          load();
        }}
      />
    </div>
  );
}
