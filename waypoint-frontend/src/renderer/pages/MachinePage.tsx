import { useEffect, useState } from 'react';
import { useAsync } from '@/lib/useAsync';
import { listProjects, detectLocalClaudeCode } from '@/data/api';
import {
  installEngine,
  startEngine,
  stopEngine,
  onEngineStatusChanged,
} from '@/data/engineApi';
import { ENGINE_PIN, type EngineStatus } from '@/types/engine';
import {
  IconGitBranch,
  IconCheck,
  IconXCircle,
  IconShield,
  IconClock,
  IconAlert,
} from '@/components/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

// Whole seconds only: sub-second precision on an uptime nobody is watching
// tick by the millisecond would be noise, not information.
function formatUptime(uptimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

type EngineStatusTone = 'neutral' | 'info' | 'success' | 'danger';

/**
 * One sentence per EngineStatus variant, and only what that variant's own
 * fields actually support — the same rule the Claude CLI probe above holds
 * to (a real Probe<T>, never a fabricated status). `failed` with
 * `incompatible` set gets its own sentence built from the daemon's own
 * reported protocol versions, matching ROAD-48's "upgrade, don't retry"
 * decision (supervisor.ts) rather than inviting a retry that cannot work.
 */
function describeEngineStatus(status: EngineStatus): {
  sentence: string;
  tone: EngineStatusTone;
} {
  switch (status.kind) {
    case 'not-installed':
      return {
        sentence: `Not installed at ${status.installDir}`,
        tone: 'neutral',
      };
    case 'stopped':
      return {
        sentence: `Installed (version ${status.version}) — not running.`,
        tone: 'neutral',
      };
    case 'starting':
      return { sentence: 'Starting…', tone: 'info' };
    case 'running':
      return {
        sentence: `Running · version ${status.health.version} · up for ${formatUptime(status.health.uptimeMs)}`,
        tone: 'success',
      };
    case 'stopping':
      return { sentence: 'Stopping…', tone: 'info' };
    case 'failed':
      if (status.incompatible) {
        return {
          sentence: `This engine speaks protocol ${status.incompatible.serverProtocolVersion}; Waypoint speaks ${status.incompatible.clientProtocolVersion} — update Waypoint.`,
          tone: 'danger',
        };
      }
      return { sentence: `Failed: ${status.message}`, tone: 'danger' };
    default: {
      // Exhaustiveness guard: EngineStatus is main/engine/types.ts's closed
      // union, which this task may not edit — a new variant there fails
      // this line to compile rather than silently rendering nothing.
      const exhaustive: never = status;
      throw new Error(`Unknown engine status: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function EngineStatusIcon({ tone }: { tone: EngineStatusTone }) {
  if (tone === 'success')
    return <IconCheck size={14} className="shrink-0 text-success" />;
  if (tone === 'danger')
    return <IconAlert size={14} className="shrink-0 text-danger" />;
  if (tone === 'info')
    return <IconClock size={14} className="shrink-0 text-text-muted" />;
  return <IconXCircle size={14} className="shrink-0 text-text-muted" />;
}

/** The Actions row's right-hand cell — an if/else chain rather than a
 *  nested ternary (the loading/no-action/actionable states are three
 *  genuinely different branches, not two ternary questions). */
function EngineActionsCell({
  status,
  action,
  transitioning,
}: {
  status: EngineStatus | null;
  action: { label: string; run: () => void } | null;
  transitioning: boolean;
}) {
  if (!status) return <Skeleton className="h-6 w-24" />;
  if (action) {
    return (
      <Button size="xs" onClick={action.run} disabled={transitioning}>
        {transitioning ? 'Working…' : action.label}
      </Button>
    );
  }
  const inProgress = status.kind === 'starting' || status.kind === 'stopping';
  return (
    <span className="text-xs text-text-muted">
      {inProgress ? 'In progress…' : 'No action available'}
    </span>
  );
}

/**
 * The one action this row can honestly offer for `status`, or `null` when
 * none applies — `starting`/`stopping` have no action (already in
 * progress), and a protocol-incompatible failure has no retry that could
 * ever succeed (supervisor.ts's own "upgrade, don't retry"). A `failed` at
 * stage `install` gets the same recheck action as `not-installed`: both are
 * answered by install()'s own verification, which is honestly all this
 * task's scope can offer here — see engineApi.ts's own comment on
 * installEngine() for why this never triggers real extraction (ROAD-47).
 */
function primaryEngineAction(
  status: EngineStatus,
  handlers: { onCheck: () => void; onStart: () => void; onStop: () => void },
): { label: string; run: () => void } | null {
  switch (status.kind) {
    case 'not-installed':
      return { label: 'Check installation', run: handlers.onCheck };
    case 'stopped':
      return { label: 'Start', run: handlers.onStart };
    case 'running':
      return { label: 'Stop', run: handlers.onStop };
    case 'starting':
    case 'stopping':
      return null;
    case 'failed':
      if (status.incompatible) return null;
      if (status.stage === 'install')
        return { label: 'Check installation', run: handlers.onCheck };
      if (status.stage === 'stop')
        return { label: 'Retry stop', run: handlers.onStop };
      return { label: 'Retry', run: handlers.onStart };
    default: {
      const exhaustive: never = status;
      throw new Error(`Unknown engine status: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * ROAD-48/51's status card. `status` starts `null` (loading) rather than
 * showing the supervisor's own provisional in-memory default (see
 * supervisor.ts's own comment on why that default exists but is never
 * rendered) — this section shows a skeleton until install()'s real,
 * observed answer comes back, the same posture the Claude CLI probe above
 * already holds to.
 */
function AgentEngineSection() {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await installEngine();
        if (!cancelled) setStatus(s);
      } catch {
        // Defense in depth, not an expected path: engineApi.ts's own
        // comment says ENGINE_IPC's install/start/stop/status never
        // reject — a broken engine is a `failed` EngineStatus, not a
        // thrown error. Swallowed rather than left unhandled so a genuine
        // contract violation cannot crash this effect.
      }
    })();
    const unsubscribe = onEngineStatusChanged((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  async function run(action: () => Promise<EngineStatus>) {
    setPending(true);
    try {
      // The resolved status is not read here — onStatusChanged above (and,
      // for install(), this same call's own caller) is the single place
      // `status` gets set, so there is exactly one path that can set it
      // rather than two that could momentarily disagree.
      await action();
    } catch {
      // Defense in depth, same as the mount effect above — see its comment.
    } finally {
      setPending(false);
    }
  }

  const description = status ? describeEngineStatus(status) : null;
  const action = status
    ? primaryEngineAction(status, {
        onCheck: () => run(installEngine),
        onStart: () => run(startEngine),
        onStop: () => run(stopEngine),
      })
    : null;
  const transitioning =
    pending || status?.kind === 'starting' || status?.kind === 'stopping';

  return (
    <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
      <h2 className="mb-3 flex items-center gap-2 font-display text-sm font-medium text-text">
        <IconShield size={15} className="text-text-muted" />
        Agent engine
      </h2>
      <div className="flex flex-col divide-y divide-border">
        <div className="flex items-center justify-between py-2 text-sm text-text">
          <span>Engine</span>
          <span className="font-mono text-xs text-text-secondary">
            {ENGINE_PIN.name} {ENGINE_PIN.version} · {ENGINE_PIN.sourceCommit}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4 py-2 text-sm text-text">
          <span className="shrink-0">Status</span>
          {description ? (
            <span className="flex min-w-0 items-center gap-1.5 text-right text-xs text-text-secondary">
              <EngineStatusIcon tone={description.tone} />
              {description.sentence}
            </span>
          ) : (
            <Skeleton className="h-4 w-40" />
          )}
        </div>
        <div className="flex items-center justify-between py-2 text-sm text-text">
          <span>Actions</span>
          <EngineActionsCell
            status={status}
            action={action}
            transitioning={transitioning}
          />
        </div>
      </div>
    </section>
  );
}

// The sidebar's "Local" strip (docs/design/waypoint-revamp-mockup.html:653,
// its own data-was: "local-first was a string in a settings select. It is
// the only position a cloud tracker structurally cannot copy, so it gets
// permanent chrome... and a screen behind it") needed a real destination —
// this is it. Honest about what's actually true today: repo links and the
// Claude Code CLI probe are real (Probe<T>, never a fabricated status); the
// data layer itself still runs through the local Postgres/Docker dev stack,
// not an embedded/offline store, so this page says that plainly rather than
// implying a fully offline app that doesn't exist yet.
export default function MachinePage() {
  const { data: projects, loading: projectsLoading } = useAsync(
    () => listProjects(),
    [],
  );
  const { data: claude, loading: claudeLoading } = useAsync(
    () => detectLocalClaudeCode(),
    [],
  );

  const linked = (projects ?? []).filter((p) => p.repoPath);
  const unlinked = (projects ?? []).filter((p) => !p.repoPath);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6 md:p-8">
      <div>
        <h1 className="font-display text-2xl font-medium text-text">
          This machine
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          What runs locally, and what Copilot can currently see on this
          computer.
        </p>
      </div>

      <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
        <h2 className="mb-3 flex items-center gap-2 font-display text-sm font-medium text-text">
          <IconShield size={15} className="text-text-muted" />
          What leaves this machine
        </h2>
        <div className="flex flex-col divide-y divide-border">
          <div className="flex items-center justify-between py-2 text-sm text-text">
            <span>Your tickets</span>
            <Badge tone="success">Never</Badge>
          </div>
          <div className="flex items-center justify-between py-2 text-sm text-text">
            <span>Your code</span>
            <Badge tone="success">Never</Badge>
          </div>
          <div className="flex items-center justify-between gap-4 py-2 text-sm text-text">
            <div>
              <span>Agent prompts</span>
              <p className="mt-0.5 text-xs text-text-muted">
                Only what you send, only when you send it — same as running{' '}
                <span className="font-mono">claude</span> in your terminal.
              </p>
            </div>
            <Badge tone="warning" className="shrink-0">
              To Anthropic, on your own subscription
            </Badge>
          </div>
          <div className="flex items-center justify-between py-2 text-sm text-text">
            <span>Telemetry</span>
            <Badge tone="neutral">Off</Badge>
          </div>
        </div>
        <p className="mt-3 text-xs text-text-secondary">
          There's no cloud backend — the server this app talks to runs on this
          machine (see below). &ldquo;Nothing leaves your laptop&rdquo; would
          still be false, so this doesn't say that; the one real exception is
          Copilot, and it's listed above rather than left out.
        </p>
      </section>

      <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
        <h2 className="mb-3 font-display text-sm font-medium text-text">
          Claude Code CLI
        </h2>
        {claudeLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : claude?.state === 'present' ? (
          <div className="flex items-center gap-2 text-sm text-text">
            <IconCheck size={16} className="text-success" />
            Detected — version {claude.value.version}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <IconXCircle size={16} className="text-text-muted" />
            Not detected on this machine
            {claude?.state === 'absent' && claude.reason
              ? ` — ${claude.reason}`
              : ''}
          </div>
        )}
      </section>

      <AgentEngineSection />

      <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
        <h2 className="mb-3 font-display text-sm font-medium text-text">
          Linked repositories
        </h2>
        {projectsLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (projects ?? []).length === 0 ? (
          <p className="text-sm text-text-secondary">No projects yet.</p>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {[...linked, ...unlinked].map((project) => (
              <div
                key={project.id}
                className="flex items-center gap-2.5 py-2.5 text-sm"
              >
                <IconGitBranch size={14} className="shrink-0 text-text-muted" />
                <span className="shrink-0 font-medium text-text">
                  {project.name}
                </span>
                {project.repoPath ? (
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                    {project.repoPath}
                  </span>
                ) : (
                  <span className="text-xs text-text-muted italic">
                    not linked
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
        <h2 className="mb-2 font-display text-sm font-medium text-text">
          Where your data lives
        </h2>
        <p className="text-sm text-text-secondary">
          Waypoint's app data currently runs through a local Postgres instance
          on this machine, not a fully embedded offline store yet — there's no
          cloud sync, but it does depend on Docker being available. A fully
          in-process local database is a planned change, not something this
          build claims today.
        </p>
      </section>
    </div>
  );
}
