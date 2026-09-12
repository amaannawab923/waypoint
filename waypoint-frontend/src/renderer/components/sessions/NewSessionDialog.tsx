import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { getWorkspace } from '@/data/api';
import { CURRENT_USER_ID } from '@/data/currentUser';
import { listRunBranches, startRun } from '@/data/engineApi';
import { useAllProjects } from '@/lib/projectsStore';
import {
  resolveProviderSelection,
  SESSION_PROVIDER_IDS,
  SESSION_PROVIDERS,
  workspaceDefaultProvider,
} from '@/lib/sessionProviders';
import type { AgentRun, SupportedProviderId } from '@/types/agentRuns';
import type { EngineStatus } from '@/types/engine';

/**
 * The New session dialog — W4, ROAD-67 (docs/design/w4-start-session.md
 * §1.2). Project (linked repositories only), provider, base branch, an
 * optional title, one primary action. The dialog collects; main starts
 * (`runs:start`), answering with the run once it is `provisioning`, and
 * the page navigates to it. A refusal from main lands under the field it
 * concerns — the engine being down is the one that replaces the form.
 *
 * The provider is emdash's rule (lib/sessionProviders.ts): the
 * workspace's default preselected, a pick here overrides it for this
 * session only, and a provider this machine does not have keeps Start
 * disabled with the sentence that says so.
 */

/** Remembered per device: the project the last session was started on. */
export const LAST_PROJECT_KEY = 'waypoint:lastSessionProject';
/** One line, the row's name — main's MAX_RUN_TITLE_CHARS, mirrored. */
export const TITLE_MAX = 120;

function readLastProject(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}
function rememberProject(id: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    // A device that refuses storage just forgets; nothing else changes.
  }
}

const fieldClass =
  'h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60';
const labelClass = 'text-xs font-medium text-text-secondary';

type BranchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; branches: string[]; suggested: string | null }
  | { kind: 'failed'; message: string };

export function NewSessionDialog({
  open,
  onClose,
  engine,
}: {
  open: boolean;
  onClose: () => void;
  /** The store's last engine status: a stopped engine replaces the form. */
  engine: EngineStatus | undefined;
}) {
  const navigate = useNavigate();
  const projects = useAllProjects();
  const linked = useMemo(
    () => projects.filter((p) => p.repoPath !== null && !p.archivedAt),
    [projects],
  );

  const [projectId, setProjectId] = useState<string>('');
  // The workspace's default (read on open) and what this dialog picked.
  const [defaultProviderId, setDefaultProviderId] =
    useState<SupportedProviderId | null>(null);
  const [providerOverride, setProviderOverride] =
    useState<SupportedProviderId | null>(null);
  // Which providers this machine has — every probe must answer before
  // the rule assumes anything about availability.
  const [installed, setInstalled] = useState<SupportedProviderId[] | null>(
    null,
  );
  const [baseRef, setBaseRef] = useState<string>('');
  const [title, setTitle] = useState('');
  const [branches, setBranches] = useState<BranchState>({ kind: 'idle' });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Opening: the last-used project when it is still linked, else the
  // first linked one; a fresh title, no override, no error from the last
  // time; the workspace default and the availability probes are read
  // afresh (a provider installed since is seen on the next open).
  useEffect(() => {
    if (!open) return undefined;
    const remembered = readLastProject();
    const first =
      linked.find((p) => p.id === remembered)?.id ?? linked[0]?.id ?? '';
    setProjectId(first);
    setTitle('');
    setError(null);
    setStarting(false);
    setProviderOverride(null);
    setDefaultProviderId(null);
    setInstalled(null);
    let cancelled = false;
    const readDefault = async () => {
      let stored: string | null = null;
      try {
        stored = (await getWorkspace()).defaultAgentProvider;
      } catch {
        // Unreadable: Waypoint's own default stands.
      }
      if (!cancelled) setDefaultProviderId(workspaceDefaultProvider(stored));
    };
    const probeAll = async () => {
      let ids: SupportedProviderId[] = [];
      try {
        const answers = await Promise.all(
          SESSION_PROVIDER_IDS.map(async (id) =>
            (await SESSION_PROVIDERS[id].probe()) ? id : null,
          ),
        );
        ids = answers.filter((id): id is SupportedProviderId => id !== null);
      } catch {
        ids = [];
      }
      if (!cancelled) setInstalled(ids);
    };
    readDefault().catch(() => {});
    probeAll().catch(() => {});
    return () => {
      cancelled = true;
    };
    // The linked list is read once per open on purpose: a project linked
    // while the dialog is up is picked up on the next open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selection = resolveProviderSelection({
    orderedProviderIds: SESSION_PROVIDER_IDS,
    defaultProviderId,
    providerOverride,
    installedProviderIds: installed ?? [],
    availabilityKnown: installed !== null,
  });
  const { providerId } = selection;
  const providerMissing =
    providerId !== null &&
    installed !== null &&
    !installed.includes(providerId);

  // The branch list follows the project, through the engine.
  const engineRunning = engine?.kind === 'running';
  useEffect(() => {
    if (!open || !projectId || !engineRunning) {
      setBranches({ kind: 'idle' });
      setBaseRef('');
      return undefined;
    }
    let cancelled = false;
    setBranches({ kind: 'loading' });
    setBaseRef('');
    const read = async () => {
      try {
        const result = await listRunBranches(projectId);
        if (cancelled) return;
        setBranches({ kind: 'ready', ...result });
        setBaseRef(result.suggested ?? '');
      } catch (reason) {
        if (cancelled) return;
        setBranches({
          kind: 'failed',
          message:
            reason instanceof Error
              ? reason.message
              : 'The branches could not be read.',
        });
      }
    };
    read().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, projectId, engineRunning]);

  const canStart =
    engineRunning &&
    !!projectId &&
    !!baseRef &&
    branches.kind === 'ready' &&
    !selection.createDisabled &&
    providerId !== null &&
    !starting;

  const start = async () => {
    if (!canStart || providerId === null) return;
    setStarting(true);
    setError(null);
    try {
      const run: AgentRun = await startRun({
        projectId,
        ownerMemberId: CURRENT_USER_ID,
        providerId,
        baseRef,
        title: title.trim() || null,
      });
      rememberProject(projectId);
      onClose();
      navigate(`/sessions/${encodeURIComponent(run.id)}`);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The session could not be started.',
      );
      setStarting(false);
    }
  };

  let body;
  if (!engineRunning) {
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-secondary">
          The agent engine is not running. Start it from This machine, then come
          back here.
        </p>
        <div>
          <Button
            size="sm"
            onClick={() => {
              onClose();
              navigate('/machine');
            }}
          >
            Open This machine
          </Button>
        </div>
      </div>
    );
  } else if (linked.length === 0) {
    body = (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-secondary">
          No project has a linked repository yet. A session runs in a worktree
          of a project&apos;s repository — link one under the project&apos;s
          settings, Codebase.
        </p>
        <div>
          <Button
            size="sm"
            onClick={() => {
              onClose();
              navigate('/projects');
            }}
          >
            Open projects
          </Button>
        </div>
      </div>
    );
  } else {
    body = (
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          start().catch(() => {});
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="new-session-project" className={labelClass}>
            Project
          </label>
          <select
            id="new-session-project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={starting}
            className={fieldClass}
          >
            {linked.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-session-provider" className={labelClass}>
              Provider
            </label>
            <select
              id="new-session-provider"
              value={providerId ?? ''}
              onChange={(e) =>
                setProviderOverride(e.target.value as SupportedProviderId)
              }
              disabled={starting || defaultProviderId === null}
              className={fieldClass}
              aria-describedby={
                providerMissing ? 'new-session-provider-error' : undefined
              }
            >
              {providerId === null && <option value="">—</option>}
              {SESSION_PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {SESSION_PROVIDERS[id].name}
                  {installed !== null && !installed.includes(id)
                    ? ' (not installed)'
                    : ''}
                  {id === defaultProviderId ? ' (default)' : ''}
                </option>
              ))}
            </select>
            {providerMissing && providerId && (
              <p
                id="new-session-provider-error"
                role="alert"
                className="text-xs text-danger"
              >
                {SESSION_PROVIDERS[providerId].name} is not installed on this
                machine.
              </p>
            )}
            {providerId === null && installed !== null && (
              <p role="alert" className="text-xs text-danger">
                No supported provider is installed on this machine.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-session-branch" className={labelClass}>
              Base branch
            </label>
            <select
              id="new-session-branch"
              value={baseRef}
              onChange={(e) => setBaseRef(e.target.value)}
              disabled={starting || branches.kind !== 'ready'}
              className={fieldClass}
              aria-describedby={
                branches.kind === 'failed'
                  ? 'new-session-branch-error'
                  : undefined
              }
            >
              {branches.kind === 'ready' ? (
                branches.branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))
              ) : (
                <option value="">
                  {branches.kind === 'loading' ? 'Reading branches…' : '—'}
                </option>
              )}
            </select>
            {branches.kind === 'failed' && (
              <p
                id="new-session-branch-error"
                role="alert"
                className="text-xs text-danger"
              >
                {branches.message}
              </p>
            )}
            {branches.kind === 'ready' && branches.branches.length === 0 && (
              <p role="alert" className="text-xs text-danger">
                This repository has no local branch to start from.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="new-session-title" className={labelClass}>
            Title{' '}
            <span className="font-normal text-text-muted">(optional)</span>
          </label>
          <input
            id="new-session-title"
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            disabled={starting}
            placeholder="What this session is for"
            className={fieldClass}
          />
        </div>

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </form>
    );
  }

  const showFooter = engineRunning && linked.length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New session"
      footer={
        showFooter ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={onClose}
              disabled={starting}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                start().catch(() => {});
              }}
              disabled={!canStart}
            >
              {starting ? 'Starting…' : 'Start session'}
            </Button>
          </>
        ) : undefined
      }
    >
      {body}
    </Modal>
  );
}
