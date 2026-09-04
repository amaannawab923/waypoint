import { clsx } from 'clsx';
import { Link } from 'react-router-dom';
import type { Probe } from '@/types/probe';
import { StatusBadge } from '@/components/ui/StatusBadge';

export type ClaudeCodeProbe = Probe<{ version: string; path: string }>;

/**
 * The "is the real Claude Code CLI installed on this machine" indicator —
 * StatusBadge itself only ever speaks in terms of a Probe's state and knows
 * nothing about what was probed, so this supplies the "Claude Code CLI"
 * label next to it, plus the version when one was actually read and a link
 * to the in-app setup flow when it wasn't found. Backs W1.2's replacement
 * of the fabricated "● Connected — Claude Code CLI v2.4.1, signed in as …"
 * string that used to render unconditionally.
 *
 * `showSetupLink` defaults on; pass `false` from a surface that already IS
 * the setup flow (profile-settings/Copilot.tsx) so it doesn't link to
 * itself.
 *
 * See docs/design/waypoint-revamp-architecture.md §1.4, §7.2, work
 * breakdown W1.2.
 */
export function ClaudeCodeStatus({
  probe,
  className,
  showSetupLink = true,
}: {
  probe: ClaudeCodeProbe;
  className?: string;
  showSetupLink?: boolean;
}) {
  return (
    <div className={clsx('flex flex-wrap items-center gap-2', className)}>
      <span className="text-sm text-text-secondary">Claude Code CLI</span>
      <StatusBadge probe={probe} />
      {probe.state === 'present' && (
        <span className="font-mono text-xs text-text-muted">
          v{probe.value.version}
        </span>
      )}
      {showSetupLink && probe.state === 'absent' && (
        <Link
          to="/profile/copilot"
          className="text-xs font-medium text-accent-soft-text hover:underline"
        >
          Set up Claude Code
        </Link>
      )}
    </div>
  );
}
