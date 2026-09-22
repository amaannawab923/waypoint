import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Switch } from '@/components/ui/Switch';
import { IconChevron } from '@/components/icons';
import { getWorkspace } from '@/data/api';
import { getActiveMemberId } from '@/data/activeIdentity';
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
import { FolderPicker } from './FolderPicker';
import { statusView } from './sessionStatus';
import { BranchPicker } from './BranchPicker';

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

/**
 * The default auto-approve: what this folder was last started with, else
 * OFF — for a worktree too. It used to default on for a worktree
 * (customer feedback round 1: "bypass permissions on by default, one
 * click from my live checkout"); a person who wants it on for a trusted
 * folder turns it on once and it is remembered.
 */
export function defaultAutoApprove(
  folder: SessionFolder,
  // Kept in the signature: the remembered choice is per folder, the
  // default no longer depends on where the agent works.
  _isolation: RunIsolation,
): boolean {
  if (folder.lastAutoApprove !== null) return folder.lastAutoApprove;
  return false;
}

const fieldClass =
  'h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60';
const labelClass = 'text-xs font-medium text-text-secondary';

type BranchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; branches: string[]; suggested: string | null }
  | { kind: 'failed'; message: string };

/** What the base-branch field shows: the branch, or why there is none yet. */
function branchFieldValue(branches: BranchState, baseRef: string): string {
  if (branches.kind === 'ready') return baseRef;
  return branches.kind === 'loading' ? 'Reading branches…' : '';
}

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
  // person has set it themselves — and switching to the folder itself
  // while auto-approve is on asks first, instead of a colour change
  // (customer feedback round 1): the agent would edit the live checkout
  // without a prompt.
  const [directConfirm, setDirectConfirm] = useState(false);
  const changeIsolation = (next: RunIsolation) => {
    setIsolation(next);
    if (next === 'directory' && autoApprove) {
      setDirectConfirm(true);
      return;
    }
    setDirectConfirm(false);
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
    !directConfirm &&
    !starting;

  const start = async () => {
    if (!canStart || !selected || providerId === null) return;
    setStarting(true);
    setError(null);
    try {
      const run: AgentRun = await startRun({
        folder: selected.handle,
        ownerMemberId: await getActiveMemberId(),
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
          <FolderPicker
            labelId="new-session-folder-label"
            folders={folders}
            selected={selected}
            onSelect={setSelected}
            onBrowse={() => {
              browse().catch(() => {});
            }}
            browsing={browsing}
            disabled={starting}
          />
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
              // S7 (PR #88 review): `changeIsolation` raises this same
              // confirm when isolation flips to 'directory' while
              // auto-approve is already on — but a plain, non-repo
              // folder gets isolation: 'directory' automatically
              // (defaultIsolation, the folder-selection effect above),
              // never through `changeIsolation` at all, and
              // defaultAutoApprove now defaults OFF. So the natural
              // path — pick a folder, tick Auto-approve, Start — never
              // went through `changeIsolation` and never asked. Raised
              // here too, the mirror image of that check: turning auto-
              // approve ON while already on a direct folder.
              if (next && isolation === 'directory') setDirectConfirm(true);
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
        {directConfirm && (
          <div
            data-direct-auto-approve-confirm
            role="alertdialog"
            aria-label="Turn off auto-approve for a direct folder?"
            className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-warning bg-warning-bg px-3 py-2 text-xs text-warning"
          >
            <span className="font-medium">
              Turn off auto-approve for a direct folder?
            </span>
            <span className="flex gap-2">
              <Button
                size="xs"
                variant="secondary"
                onClick={() => {
                  setAutoApproveTouched(true);
                  setDirectConfirm(false);
                }}
              >
                Keep it on
              </Button>
              <Button
                size="xs"
                variant="primary"
                onClick={() => {
                  setAutoApprove(false);
                  setAutoApproveTouched(true);
                  setDirectConfirm(false);
                }}
              >
                Turn it off
              </Button>
            </span>
          </div>
        )}

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
                  <BranchPicker
                    id="new-session-branch"
                    branches={
                      branches.kind === 'ready' ? branches.branches : []
                    }
                    value={branchFieldValue(branches, baseRef)}
                    onChange={setBaseRef}
                    disabled={
                      starting || !worktree || branches.kind !== 'ready'
                    }
                    className={fieldClass}
                  />
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
