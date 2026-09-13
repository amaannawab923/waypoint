import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Switch } from '@/components/ui/Switch';
import { IconChevron, IconFolder, IconGitBranch } from '@/components/icons';
import { getWorkspace } from '@/data/api';
import { CURRENT_USER_ID } from '@/data/currentUser';
import {
  chooseFolder,
  listRecentFolders,
  listRunBranches,
  startRun,
} from '@/data/engineApi';
import {
  resolveProviderSelection,
  SESSION_PROVIDER_IDS,
  SESSION_PROVIDERS,
  workspaceDefaultProvider,
} from '@/lib/sessionProviders';
import { useSessionsSnapshot } from '@/lib/sessionsStore';
import type {
  AgentRun,
  RunIsolation,
  SessionFolder,
  SupportedProviderId,
} from '@/types/agentRuns';
import type { EngineStatus } from '@/types/engine';
import { statusView } from './sessionStatus';

/**
 * The New session dialog — W4b, ROAD-116 (docs/design/w4b-sessions-anywhere.md
 * §1.1), reshaped from W4 after the emdash comparison. Folder → provider →
 * first message → auto-approve → (advanced) where to work and the base
 * branch → Start. The dialog collects; main starts (`runs:start`) and
 * answers with the run once it is `provisioning`; the page navigates to
 * it.
 *
 * Folders are handles main minted (the picker, its recents, the projects'
 * linked repositories); the renderer shows the description and hands the
 * handle back. The defaults fall out of the folder: a git repository →
 * a fresh worktree with auto-approve on; a plain folder → work in it
 * directly with auto-approve off; the last auto-approve choice for a
 * folder wins over both. The provider is emdash's rule
 * (lib/sessionProviders.ts).
 */

/** Remembered per device: the folder the last session was started in (its path, for matching main's list). */
export const LAST_FOLDER_KEY = 'waypoint:lastSessionFolder';
/** The most a first message may be — main's MAX_FIRST_MESSAGE_CHARS, mirrored. */
export const FIRST_MESSAGE_MAX = 20_000;

function readLastFolder(): string | null {
  try {
    return window.localStorage.getItem(LAST_FOLDER_KEY);
  } catch {
    return null;
  }
}
function rememberFolder(folderPath: string): void {
  try {
    window.localStorage.setItem(LAST_FOLDER_KEY, folderPath);
  } catch {
    // A device that refuses storage just forgets; nothing else changes.
  }
}

/** What auto-approve means here, in the sentence under the switch. */
export function autoApproveSentence(isolation: RunIsolation): string {
  return isolation === 'worktree'
    ? 'The agent works in its own copy; edits and commands run without asking.'
    : 'The agent edits this folder directly; with this off you are asked before each write.';
}

/** The default isolation for a folder: a fresh worktree of a repository, direct otherwise. */
export function defaultIsolation(folder: SessionFolder): RunIsolation {
  return folder.kind === 'repo' ? 'worktree' : 'directory';
}

/** The default auto-approve: what this folder was last started with, else what the isolation implies. */
export function defaultAutoApprove(
  folder: SessionFolder,
  isolation: RunIsolation,
): boolean {
  if (folder.lastAutoApprove !== null) return folder.lastAutoApprove;
  return isolation === 'worktree';
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
  const { runs } = useSessionsSnapshot();

  const [folders, setFolders] = useState<SessionFolder[] | null>(null);
  const [selected, setSelected] = useState<SessionFolder | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [defaultProviderId, setDefaultProviderId] =
    useState<SupportedProviderId | null>(null);
  const [providerOverride, setProviderOverride] =
    useState<SupportedProviderId | null>(null);
  const [installed, setInstalled] = useState<SupportedProviderId[] | null>(
    null,
  );
  const [firstMessage, setFirstMessage] = useState('');
  const [isolation, setIsolation] = useState<RunIsolation>('worktree');
  const [autoApprove, setAutoApprove] = useState(false);
  const [autoApproveTouched, setAutoApproveTouched] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [baseRef, setBaseRef] = useState('');
  const [branches, setBranches] = useState<BranchState>({ kind: 'idle' });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engineRunning = engine?.kind === 'running';

  // Opening: the folders main offers (the last-used one preselected),
  // the workspace's provider and the availability probes, all afresh; a
  // fresh message, no override, no error from the last time.
  useEffect(() => {
    if (!open) return undefined;
    setFolders(null);
    setSelected(null);
    setFirstMessage('');
    setError(null);
    setStarting(false);
    setProviderOverride(null);
    setDefaultProviderId(null);
    setInstalled(null);
    setAutoApproveTouched(false);
    setAdvancedOpen(false);
    let cancelled = false;
    const readFolders = async () => {
      let listed: SessionFolder[] = [];
      try {
        listed = await listRecentFolders();
      } catch {
        listed = [];
      }
      if (cancelled) return;
      setFolders(listed);
      const remembered = readLastFolder();
      setSelected(
        listed.find((f) => f.path === remembered) ?? listed[0] ?? null,
      );
    };
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
    if (engineRunning) readFolders().catch(() => {});
    readDefault().catch(() => {});
    probeAll().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, engineRunning]);

  // A folder chosen: its defaults, and its branches when it is a repository.
  useEffect(() => {
    if (!selected) return undefined;
    const iso = defaultIsolation(selected);
    setIsolation(iso);
    setAutoApprove(defaultAutoApprove(selected, iso));
    setAutoApproveTouched(false);
    setError(null);
    if (selected.kind !== 'repo' || !engineRunning) {
      setBranches({ kind: 'idle' });
      setBaseRef('');
      return undefined;
    }
    let cancelled = false;
    setBranches({ kind: 'loading' });
    setBaseRef('');
    const read = async () => {
      try {
        const result = await listRunBranches(selected.handle);
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
  }, [selected, engineRunning]);

  // Flipping where the agent works re-defaults auto-approve unless the
  // person has set it themselves.
  const changeIsolation = (next: RunIsolation) => {
    setIsolation(next);
    if (!autoApproveTouched && selected)
      setAutoApprove(defaultAutoApprove(selected, next));
  };

  const browse = async () => {
    setBrowsing(true);
    try {
      const choice = await chooseFolder();
      if (choice.canceled) return;
      setFolders((current) => {
        const rest = (current ?? []).filter(
          (f) => f.path !== choice.folder.path,
        );
        return [choice.folder, ...rest];
      });
      setSelected(choice.folder);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'The folder was not picked.',
      );
    } finally {
      setBrowsing(false);
    }
  };

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

  // A live session already in this folder: said, not refused.
  const busy = useMemo(
    () =>
      selected
        ? runs.filter(
            (r) => r.cwd === selected.path && statusView(r.status).live,
          ).length
        : 0,
    [runs, selected],
  );

  const worktree = isolation === 'worktree';
  const canStart =
    engineRunning &&
    !!selected &&
    providerId !== null &&
    !selection.createDisabled &&
    (!worktree || (branches.kind === 'ready' && !!baseRef)) &&
    !starting;

  const start = async () => {
    if (!canStart || !selected || providerId === null) return;
    setStarting(true);
    setError(null);
    try {
      const run: AgentRun = await startRun({
        folder: selected.handle,
        ownerMemberId: CURRENT_USER_ID,
        providerId,
        isolation,
        autoApprove,
        baseRef: worktree ? baseRef : null,
        firstMessage: firstMessage.trim() || null,
      });
      rememberFolder(selected.path);
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
          <div className="flex items-center justify-between">
            <span id="new-session-folder-label" className={labelClass}>
              Folder
            </span>
            <button
              type="button"
              onClick={() => {
                browse().catch(() => {});
              }}
              disabled={starting || browsing}
              className="text-xs font-medium text-text-secondary underline-offset-2 hover:text-text hover:underline disabled:opacity-50"
            >
              {browsing ? 'Choosing…' : 'Browse…'}
            </button>
          </div>
          <div
            role="radiogroup"
            aria-labelledby="new-session-folder-label"
            className="thin-scroll flex max-h-[176px] flex-col gap-1 overflow-y-auto rounded-[var(--radius-sm)] border border-border-strong bg-bg p-1"
          >
            {folders === null && (
              <div className="px-2 py-3 text-xs text-text-muted">
                Reading folders…
              </div>
            )}
            {folders !== null && folders.length === 0 && (
              <div className="px-2 py-3 text-xs text-text-muted">
                No folder yet — Browse… to pick one. A project&apos;s linked
                repository shows up here on its own.
              </div>
            )}
            {(folders ?? []).map((folder) => {
              const isSelected = selected?.path === folder.path;
              return (
                <button
                  key={folder.path}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => setSelected(folder)}
                  disabled={starting}
                  className={clsx(
                    'flex w-full items-center gap-2.5 rounded-[5px] px-2 py-1.5 text-left',
                    isSelected
                      ? 'bg-accent-soft-bg text-accent-soft-text'
                      : 'text-text hover:bg-surface-2',
                  )}
                >
                  {folder.kind === 'repo' ? (
                    <IconGitBranch size={13} className="shrink-0 opacity-70" />
                  ) : (
                    <IconFolder size={13} className="shrink-0 opacity-70" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {folder.name}
                      {folder.projectName && (
                        <span className="ml-1.5 text-xs font-normal opacity-70">
                          · {folder.projectName}
                        </span>
                      )}
                    </span>
                    <span className="block truncate font-mono text-[11px] opacity-70">
                      {folder.displayPath}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] tracking-wide uppercase opacity-70">
                    {folder.kind === 'repo' ? 'git repo' : 'folder'}
                  </span>
                </button>
              );
            })}
          </div>
          {busy > 0 && (
            <p className="text-xs text-warning">
              {busy === 1
                ? 'A session is already running in this folder.'
                : `${busy} sessions are already running in this folder.`}
            </p>
          )}
        </div>

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
          <label htmlFor="new-session-message" className={labelClass}>
            First message{' '}
            <span className="font-normal text-text-muted">(optional)</span>
          </label>
          <textarea
            id="new-session-message"
            value={firstMessage}
            maxLength={FIRST_MESSAGE_MAX}
            onChange={(e) => setFirstMessage(e.target.value)}
            disabled={starting}
            rows={3}
            placeholder="What the agent should do. Its first line names the session."
            className="thin-scroll resize-none rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        <div className="flex items-start gap-3">
          <Switch
            id="new-session-auto-approve"
            label="Auto-approve"
            checked={autoApprove}
            disabled={starting || !selected}
            onChange={(next) => {
              setAutoApprove(next);
              setAutoApproveTouched(true);
            }}
          />
          <label
            htmlFor="new-session-auto-approve"
            className="flex min-w-0 flex-col gap-0.5"
          >
            <span className="text-sm font-medium text-text">Auto-approve</span>
            <span
              data-auto-approve-sentence
              className={clsx(
                'text-xs',
                autoApprove && !worktree
                  ? 'text-warning'
                  : 'text-text-secondary',
              )}
            >
              {autoApproveSentence(isolation)}
            </span>
          </label>
        </div>

        {selected?.kind === 'repo' && (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              className="flex items-center gap-1 self-start text-xs font-medium text-text-secondary hover:text-text"
            >
              <IconChevron
                size={12}
                className={clsx(
                  'transition-transform',
                  advancedOpen && 'rotate-180',
                )}
              />
              Advanced
              <span className="ml-1 font-normal text-text-muted">
                ·{' '}
                {worktree
                  ? `fresh worktree from ${baseRef || '…'}`
                  : 'in the folder directly'}
              </span>
            </button>
            {advancedOpen && (
              <div className="grid grid-cols-2 gap-3 rounded-[var(--radius-sm)] border border-border bg-bg-inset p-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="new-session-isolation" className={labelClass}>
                    Work in
                  </label>
                  <select
                    id="new-session-isolation"
                    value={isolation}
                    onChange={(e) =>
                      changeIsolation(e.target.value as RunIsolation)
                    }
                    disabled={starting}
                    className={fieldClass}
                  >
                    <option value="worktree">A fresh worktree</option>
                    <option value="directory">This folder directly</option>
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="new-session-branch" className={labelClass}>
                    Base branch
                  </label>
                  <select
                    id="new-session-branch"
                    value={baseRef}
                    onChange={(e) => setBaseRef(e.target.value)}
                    disabled={
                      starting || !worktree || branches.kind !== 'ready'
                    }
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
                        {branches.kind === 'loading'
                          ? 'Reading branches…'
                          : '—'}
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
                </div>
              </div>
            )}
          </div>
        )}
        {worktree && branches.kind === 'failed' && !advancedOpen && (
          <p role="alert" className="text-xs text-danger">
            {branches.message}
          </p>
        )}

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </form>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New session"
      width={540}
      footer={
        engineRunning ? (
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
