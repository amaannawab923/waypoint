import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import { connectJira, getJiraConnectionStatus } from '@/data/jiraApi';
import { setJiraConnection } from '@/lib/jiraStore';
import { showErrorToast } from '@/lib/toast';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { IconFolder, IconRefresh } from '@/components/icons';
import { JiraMark } from '@/components/domain/JiraMark';
import { CreateProjectModal } from '@/components/domain/CreateProjectModal';
import type { Project } from '@/types/entities';
import type { JiraConnectionStatus } from '@/types/jira';

// Where the mockup and this codebase genuinely conflict, and how this file
// resolves it (see the handoff notes this was built from for the full
// reasoning): the real Project entity has no "type" concept and no backend
// for one — building the mockup's 5-step type→provider→connect→site→confirm
// flow as a gate in front of ALL project creation would mean either faking a
// type field onto Project for a feature that's explicitly frontend-only
// mock, or always showing the Companion option regardless of the feature
// flag. Neither is acceptable, so this file is a NEW wrapper, mounted by
// Sidebar.tsx ONLY when MY_JIRA_ENABLED is true; with the flag off, Sidebar
// renders CreateProjectModal directly and this file isn't in the tree at
// all — the "+" button's behavior is then observably identical to before
// this existed. Choosing "Independent" here at step 1 delegates immediately
// to that same real CreateProjectModal rather than reimplementing project
// creation.

type WizardStep = 1 | 2 | 3 | 4 | 5;
type ProjectType = 'independent' | 'companion';

const TOTAL_STEPS = 5;

const STEP_TITLES: Record<WizardStep, string> = {
  1: 'Add project',
  2: 'Choose a provider',
  3: 'Connect your account',
  4: 'Choose your Atlassian site',
  5: 'Review & create',
};

const SITES: { site: string; label: string }[] = [
  { site: 'northwind.atlassian.net', label: '6 yours' },
  { site: 'northwind-labs.atlassian.net', label: '0 yours' },
];

function TypeStep({
  chosen,
  onPick,
}: {
  chosen: ProjectType | null;
  onPick: (type: ProjectType) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      <button
        type="button"
        onClick={() => onPick('independent')}
        className={clsx(
          'rounded-[var(--radius)] border-[1.5px] p-3.5 text-left transition-colors',
          chosen === 'independent'
            ? 'border-accent bg-accent-soft-bg'
            : 'border-border-strong bg-surface hover:bg-surface-2',
        )}
      >
        <div
          className={clsx(
            'mb-2 flex size-7 items-center justify-center rounded-md',
            chosen === 'independent'
              ? 'bg-accent text-on-accent'
              : 'bg-surface-3 text-text-secondary',
          )}
        >
          <IconFolder size={14} />
        </div>
        <b className="block text-[13.5px] font-semibold text-text">
          Independent project
        </b>
        <p className="mt-0.5 text-xs leading-snug text-text-secondary">
          Tickets, sprints, docs and workstreams — all owned by Waypoint, all
          local.
        </p>
      </button>
      <button
        type="button"
        onClick={() => onPick('companion')}
        className={clsx(
          'rounded-[var(--radius)] border-[1.5px] p-3.5 text-left transition-colors',
          chosen === 'companion'
            ? 'border-accent bg-accent-soft-bg'
            : 'border-border-strong bg-surface hover:bg-surface-2',
        )}
      >
        <div
          className={clsx(
            'mb-2 flex size-7 items-center justify-center rounded-md',
            chosen === 'companion'
              ? 'bg-accent text-on-accent'
              : 'bg-surface-3 text-text-secondary',
          )}
        >
          <IconRefresh size={14} />
        </div>
        <b className="block text-[13.5px] font-semibold text-text">
          Companion project
        </b>
        <p className="mt-0.5 text-xs leading-snug text-text-secondary">
          Your own work from an external tracker, mirrored live — and writable
          from here.
        </p>
      </button>
    </div>
  );
}

function ProviderStep({
  chosen,
  onPick,
}: {
  chosen: 'jira' | null;
  onPick: (provider: 'jira') => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => onPick('jira')}
        className={clsx(
          'flex items-center gap-2.5 rounded-[var(--radius)] border-[1.5px] px-3 py-2.5 text-left transition-colors',
          chosen === 'jira'
            ? 'border-accent bg-accent-soft-bg'
            : 'border-border-strong bg-surface hover:bg-surface-2',
        )}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-jira-bg text-jira">
          <JiraMark size={15} />
        </span>
        <span>
          <b className="block text-[13.5px] font-semibold text-text">Jira</b>
          <span className="text-xs text-text-muted">Atlassian Cloud</span>
        </span>
      </button>
      {(['Linear', 'Shortcut'] as const).map((name) => (
        <div
          key={name}
          aria-disabled="true"
          className="flex items-center gap-2.5 rounded-[var(--radius)] border-[1.5px] border-border-strong bg-surface px-3 py-2.5 opacity-55"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-text-muted">
            <IconFolder size={14} />
          </span>
          <b className="text-[13.5px] font-semibold text-text">{name}</b>
          <Badge
            tone="neutral"
            className="ml-auto px-1.5 py-0 text-[10px] leading-4"
          >
            Not built yet
          </Badge>
        </div>
      ))}
    </div>
  );
}

function ConnectStep({
  connecting,
  connectionStatus,
  onConnect,
}: {
  connecting: boolean;
  connectionStatus: JiraConnectionStatus | null;
  onConnect: () => void;
}) {
  if (connectionStatus?.connected) {
    return (
      <div className="flex items-center gap-3 rounded-[var(--radius)] border border-border px-4 py-3.5">
        <Avatar name={connectionStatus.accountName} size={34} />
        <div>
          <b className="block text-[13.5px] font-semibold text-text">
            {connectionStatus.accountName}
          </b>
          <div className="text-xs text-text-muted">
            {connectionStatus.accountEmail}
          </div>
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-success-bg py-1 pr-2.5 pl-2 text-[11.5px] font-bold text-success">
          <span className="size-1.5 shrink-0 rounded-full bg-success" />
          Connected
        </span>
      </div>
    );
  }
  return (
    <div>
      <p className="mb-4 text-[13px] leading-relaxed text-text-secondary">
        Waypoint mirrors <b className="text-text">your</b> Jira work —
        everything assigned to, reported by, or watched by you. There&apos;s no
        board to pick.
      </p>
      <Button
        variant="primary"
        className="w-full justify-center"
        disabled={connecting}
        onClick={onConnect}
      >
        {connecting ? 'Waiting for Atlassian…' : 'Connect Jira account'}
      </Button>
      <div className="mt-3.5 flex items-start gap-2 rounded-[var(--radius-sm)] border border-accent/30 bg-accent-soft-bg px-3 py-2.5 text-[12.5px] leading-relaxed text-accent-soft-text">
        Opens Atlassian&apos;s own sign-in in your browser. Waypoint never sees
        your password, and writes are attributed to you, not to a service
        account.
      </div>
    </div>
  );
}

function SiteStep({
  selectedSite,
  onPick,
}: {
  selectedSite: string;
  onPick: (site: string) => void;
}) {
  return (
    <div>
      <p className="mb-3 text-[12.5px] text-text-secondary">
        Your account can see two Atlassian sites. Pick the one you work in —
        this is the only thing left to choose.
      </p>
      <div className="flex flex-col gap-1.5">
        {SITES.map((s) => (
          <button
            key={s.site}
            type="button"
            onClick={() => onPick(s.site)}
            className={clsx(
              'flex items-center gap-2.5 rounded-[var(--radius-sm)] border-[1.5px] px-2.5 py-2 text-left transition-colors',
              selectedSite === s.site
                ? 'border-accent bg-accent-soft-bg'
                : 'border-border-strong hover:bg-surface-2',
            )}
          >
            <span
              className={clsx(
                'relative size-[15px] shrink-0 rounded-full border-2',
                selectedSite === s.site
                  ? 'border-accent'
                  : 'border-border-strong',
              )}
            >
              {selectedSite === s.site && (
                <span className="absolute inset-[2px] rounded-full bg-accent" />
              )}
            </span>
            <span className="flex-1 text-[13px] font-medium text-text">
              {s.site}
            </span>
            <span className="text-[11.5px] text-text-muted">{s.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ConfirmStep({
  site,
  connectionStatus,
}: {
  site: string;
  connectionStatus: JiraConnectionStatus | null;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-3 rounded-[var(--radius)] border border-border bg-surface-2 p-3.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-jira-bg text-jira">
          <JiraMark size={18} />
        </span>
        <div>
          <b className="text-sm font-semibold text-text">My Jira</b>
          <div className="mt-0.5 text-xs text-text-muted">
            {site} · your work across every project you can see
          </div>
        </div>
      </div>
      <div className="mb-3 flex gap-5">
        <div>
          <b className="block font-mono text-[15px] font-bold text-text">
            {connectionStatus?.issueCount ?? 0}
          </b>
          <span className="text-[11.5px] text-text-muted">
            issues, {connectionStatus?.projectCount ?? 0} projects
          </span>
        </div>
        <div>
          <b className="block font-mono text-[15px] font-bold text-text">1</b>
          <span className="text-[11.5px] text-text-muted">
            API call to load
          </span>
        </div>
        <div>
          <b className="block font-mono text-[15px] font-bold text-text">
            {connectionStatus?.pollIntervalSec ?? 15}s
          </b>
          <span className="text-[11.5px] text-text-muted">
            refresh, feels live
          </span>
        </div>
      </div>
      <div className="flex items-start gap-2 rounded-[var(--radius-sm)] border border-jira/30 bg-jira-bg px-3 py-2.5 text-[12.5px] leading-relaxed text-jira">
        Moving, commenting and closing from Waypoint changes the real issues.
        Sprints, Docs and Workstreams don&apos;t appear here — Jira owns those,
        and Waypoint won&apos;t fake a mirror of them.
      </div>
    </div>
  );
}

export function AddProjectWizard({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<'wizard' | 'independent'>('wizard');
  const [step, setStep] = useState<WizardStep>(1);
  const [chosenType, setChosenType] = useState<ProjectType | null>(null);
  const [chosenProvider, setChosenProvider] = useState<'jira' | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<JiraConnectionStatus | null>(null);
  const [selectedSite, setSelectedSite] = useState(SITES[0].site);
  const [finishing, setFinishing] = useState(false);

  function resetAll() {
    setPhase('wizard');
    setStep(1);
    setChosenType(null);
    setChosenProvider(null);
    setConnecting(false);
    setConnectionStatus(null);
    setSelectedSite(SITES[0].site);
    setFinishing(false);
  }

  function handleClose() {
    resetAll();
    onClose();
  }

  async function handleConnectJira() {
    setConnecting(true);
    try {
      const status = await connectJira();
      setJiraConnection(status);
      setConnectionStatus(status);
    } catch (err) {
      showErrorToast(
        err instanceof Error ? err.message : 'Could not connect to Jira.',
      );
    } finally {
      setConnecting(false);
    }
  }

  async function handleFinishCompanion() {
    setFinishing(true);
    try {
      // Continue on step 3 is disabled until connected, so this is normally
      // already true — the fallback exists so this never fires a duplicate
      // "Connect Jira account" click either way.
      let status = connectionStatus;
      if (!status?.connected) {
        status = await connectJira();
        setJiraConnection(status);
      } else {
        // Already connected — re-read so the sidebar/page reflect the final
        // site choice's issue counts rather than a stale snapshot.
        status = await getJiraConnectionStatus();
        setJiraConnection(status);
      }
      resetAll();
      onClose();
      navigate('/my-jira');
    } catch (err) {
      showErrorToast(
        err instanceof Error
          ? err.message
          : 'Could not finish connecting Jira.',
      );
    } finally {
      setFinishing(false);
    }
  }

  function handleBack() {
    setStep((s) => (s > 1 ? ((s - 1) as WizardStep) : s));
  }

  function handleNext() {
    if (step === 1) {
      if (chosenType === 'independent') {
        setPhase('independent');
        return;
      }
      setStep(2);
      return;
    }
    if (step < TOTAL_STEPS) {
      setStep((s) => (s + 1) as WizardStep);
      return;
    }
    void handleFinishCompanion();
  }

  if (phase === 'independent') {
    return (
      <CreateProjectModal
        open={open}
        onClose={() => {
          resetAll();
          onClose();
        }}
        onCreated={(project) => {
          resetAll();
          onCreated(project);
        }}
      />
    );
  }

  const nextDisabled =
    step === 1
      ? !chosenType
      : step === 2
        ? chosenProvider !== 'jira'
        : step === 3
          ? !connectionStatus?.connected
          : finishing;

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={STEP_TITLES[step]}
      footer={
        <>
          {step > 1 && (
            <Button variant="ghost" onClick={handleBack}>
              Back
            </Button>
          )}
          <Button
            variant="primary"
            disabled={nextDisabled}
            onClick={handleNext}
          >
            {step === TOTAL_STEPS
              ? finishing
                ? 'Creating…'
                : 'Create project'
              : 'Continue'}
          </Button>
        </>
      }
    >
      {step === 1 && <TypeStep chosen={chosenType} onPick={setChosenType} />}
      {step === 2 && (
        <ProviderStep chosen={chosenProvider} onPick={setChosenProvider} />
      )}
      {step === 3 && (
        <ConnectStep
          connecting={connecting}
          connectionStatus={connectionStatus}
          onConnect={handleConnectJira}
        />
      )}
      {step === 4 && (
        <SiteStep selectedSite={selectedSite} onPick={setSelectedSite} />
      )}
      {step === 5 && (
        <ConfirmStep site={selectedSite} connectionStatus={connectionStatus} />
      )}
    </Modal>
  );
}
