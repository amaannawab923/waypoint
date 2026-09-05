import { useState, type ChangeEvent } from 'react';
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

// Four steps, not the five this had while the connect step was simulated.
// The step that disappeared was "Choose your Atlassian site", which offered a
// hardcoded pair of sites to pick between. A personal API-token connection
// has no site-discovery step to make: a token authenticates one person
// against one site, and which site that is has to be typed in anyway, so it
// belongs on the connect form beside the email and the token rather than
// being asked for again afterwards as though something had enumerated it.
type WizardStep = 1 | 2 | 3 | 4;
type ProjectType = 'independent' | 'companion';

const TOTAL_STEPS = 4;

const STEP_TITLES: Record<WizardStep, string> = {
  1: 'Add project',
  2: 'Choose a provider',
  3: 'Connect your Jira account',
  4: 'Review & create',
};

const API_TOKEN_URL =
  'https://id.atlassian.com/manage-profile/security/api-tokens';

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

const FIELD_CLASS =
  'w-full rounded-[var(--radius-sm)] border border-border-strong bg-surface px-2.5 py-2 text-[13px] text-text outline-none focus:border-accent';

/** One labelled input on the connect form. `htmlFor`/`id` are wired properly
 * rather than left to a wrapping label, so the three fields are individually
 * addressable by name — for a screen reader, and for a test. */
function ConnectField({
  id,
  label,
  hint,
  type,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  type?: string;
  value: string;
  placeholder?: string;
  disabled: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="mb-2.5">
      <label
        htmlFor={id}
        className="mb-1 block text-[11px] font-bold text-text-secondary"
      >
        {label}
      </label>
      <input
        id={id}
        className={FIELD_CLASS}
        type={type ?? 'text'}
        value={value}
        placeholder={placeholder}
        // Off on all three: a browser-remembered value is exactly wrong for a
        // one-time API token, and offering to remember one is worse.
        autoComplete="off"
        disabled={disabled}
        onChange={onChange}
      />
      {hint && <div className="mt-1 text-[10.5px] text-text-muted">{hint}</div>}
    </div>
  );
}

/**
 * The real connect form: site, Atlassian account email, API token.
 *
 * This replaces a button that waited on a timer and declared success. What
 * happens now is a live `GET /rest/api/3/myself` against the site the user
 * typed, authenticated with these exact credentials — so "Connected", and the
 * name and avatar shown beside it, are Jira's own answer about who this
 * account is, not a fixture.
 *
 * There is deliberately no second "Sign in with Atlassian" button next to
 * this one. OAuth is a real and better answer for an organizational install,
 * but it is a separate mechanism that is not built; a control that starts a
 * flow which doesn't exist is exactly what this app's honesty rules exist to
 * prevent, and half-stubbing it would be worse than its absence.
 */
function ConnectStep({
  site,
  email,
  apiToken,
  connecting,
  error,
  connectionStatus,
  onFieldChange,
  onConnect,
}: {
  site: string;
  email: string;
  apiToken: string;
  connecting: boolean;
  error: string | null;
  connectionStatus: JiraConnectionStatus | null;
  onFieldChange: (field: 'site' | 'email' | 'apiToken', value: string) => void;
  onConnect: () => void;
}) {
  if (connectionStatus?.connected) {
    return (
      <div className="flex items-center gap-3 rounded-[var(--radius)] border border-border px-4 py-3.5">
        <Avatar name={connectionStatus.accountName} size={34} />
        <div className="min-w-0">
          <b className="block text-[13.5px] font-semibold text-text">
            {connectionStatus.accountName}
          </b>
          <div className="truncate text-xs text-text-muted">
            {connectionStatus.accountEmail} · {connectionStatus.site}
          </div>
        </div>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success-bg py-1 pr-2.5 pl-2 text-[11.5px] font-bold text-success">
          <span className="size-1.5 shrink-0 rounded-full bg-success" />
          Connected
        </span>
      </div>
    );
  }

  const canSubmit =
    !connecting && site.trim() && email.trim() && apiToken.trim();

  return (
    <div>
      <p className="mb-3.5 text-[13px] leading-relaxed text-text-secondary">
        Waypoint mirrors <b className="text-text">your</b> Jira work —
        everything assigned to, reported by, or watched by you. There&apos;s no
        board to pick.
      </p>

      <ConnectField
        id="jira-site"
        label="Jira site"
        value={site}
        placeholder="yourteam.atlassian.net"
        disabled={connecting}
        onChange={(e) => onFieldChange('site', e.target.value)}
        hint="The address you open Jira at. Pasting the full URL is fine."
      />
      <ConnectField
        id="jira-email"
        label="Atlassian account email"
        type="email"
        value={email}
        placeholder="you@yourteam.com"
        disabled={connecting}
        onChange={(e) => onFieldChange('email', e.target.value)}
      />
      <ConnectField
        id="jira-token"
        label="API token"
        type="password"
        value={apiToken}
        placeholder="Paste your API token"
        disabled={connecting}
        onChange={(e) => onFieldChange('apiToken', e.target.value)}
      />

      <p className="mb-3 text-[11.5px] leading-relaxed text-text-muted">
        Create one at{' '}
        <a
          href={API_TOKEN_URL}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent underline"
        >
          id.atlassian.com › Security › API tokens
        </a>
        . Not your Atlassian password — a token you generate, and can revoke,
        yourself.
      </p>

      <Button
        variant="primary"
        className="w-full justify-center"
        disabled={!canSubmit}
        onClick={onConnect}
      >
        {connecting ? 'Checking with Jira…' : 'Connect'}
      </Button>

      {error && (
        <div
          role="alert"
          className="mt-3 rounded-[var(--radius-sm)] border border-danger/30 bg-danger-bg px-3 py-2.5 text-[12.5px] leading-relaxed text-danger"
        >
          {error}
        </div>
      )}

      <div className="mt-3.5 flex items-start gap-2 rounded-[var(--radius-sm)] border border-accent/30 bg-accent-soft-bg px-3 py-2.5 text-[12.5px] leading-relaxed text-accent-soft-text">
        The token is encrypted with your operating system&apos;s own key store
        and never leaves this machine except to your Jira site. Writes are
        attributed to you, not to a service account.
      </div>
    </div>
  );
}

function ConfirmStep({
  connectionStatus,
}: {
  connectionStatus: JiraConnectionStatus | null;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-3 rounded-[var(--radius)] border border-border bg-surface-2 p-3.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-jira-bg text-jira">
          <JiraMark size={18} />
        </span>
        <div className="min-w-0">
          <b className="text-sm font-semibold text-text">My Jira</b>
          <div className="mt-0.5 truncate text-xs text-text-muted">
            {connectionStatus?.site} · your work across every project you can
            see
          </div>
        </div>
      </div>
      {/* These counts are the real result of the JQL search that ran the
          moment the connection was accepted — not an estimate, and not a
          placeholder. The third stat used to claim a background refresh
          interval; nothing polls, so it says what actually happens instead. */}
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
  const [connectError, setConnectError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState({
    site: '',
    email: '',
    apiToken: '',
  });
  const [connectionStatus, setConnectionStatus] =
    useState<JiraConnectionStatus | null>(null);
  const [finishing, setFinishing] = useState(false);

  function resetAll() {
    setPhase('wizard');
    setStep(1);
    setChosenType(null);
    setChosenProvider(null);
    setConnecting(false);
    setConnectError(null);
    // Dropped on every close, not just on success: an API token is a live
    // credential, and there is no reason for one to sit in renderer state
    // after the form it was typed into is gone.
    setCredentials({ site: '', email: '', apiToken: '' });
    setConnectionStatus(null);
    setFinishing(false);
  }

  function handleClose() {
    resetAll();
    onClose();
  }

  function handleFieldChange(
    field: 'site' | 'email' | 'apiToken',
    value: string,
  ) {
    setCredentials((prev) => ({ ...prev, [field]: value }));
    // Editing any field invalidates the last rejection — leaving "Jira
    // rejected that token" under a token the user has since corrected reads
    // as a fresh failure.
    setConnectError(null);
  }

  async function handleConnectJira() {
    setConnecting(true);
    setConnectError(null);
    try {
      const status = await connectJira(credentials);
      setJiraConnection(status);
      setConnectionStatus(status);
      // The token has done its job — main holds it, encrypted, from here on.
      setCredentials((prev) => ({ ...prev, apiToken: '' }));
    } catch (err) {
      // Inline on the form rather than a toast: this is a form validation
      // outcome the user has to act on in-place, and main already
      // distinguishes bad credentials from an unreachable site from an
      // address that isn't a Jira site at all — that specificity is worth
      // showing next to the field it's about.
      setConnectError(
        err instanceof Error ? err.message : 'Could not connect to Jira.',
      );
    } finally {
      setConnecting(false);
    }
  }

  async function handleFinishCompanion() {
    setFinishing(true);
    try {
      // Continue on step 3 is disabled until connected, so this re-read is
      // just picking up the freshest counts for the sidebar and the page —
      // it never has to perform the connection itself.
      const status = await getJiraConnectionStatus();
      setJiraConnection(status);
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
          site={credentials.site}
          email={credentials.email}
          apiToken={credentials.apiToken}
          connecting={connecting}
          error={connectError}
          connectionStatus={connectionStatus}
          onFieldChange={handleFieldChange}
          onConnect={handleConnectJira}
        />
      )}
      {step === 4 && <ConfirmStep connectionStatus={connectionStatus} />}
    </Modal>
  );
}
