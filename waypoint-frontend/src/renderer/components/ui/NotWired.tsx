import { IconAlert } from '@/components/icons';
import { CAPABILITIES } from '@/capabilities';
import type { Capability, CapabilityKey } from '@/capabilities';

/**
 * Renders the register's own note for a `not-wired`/`partial` capability, in
 * a consistent, unmissable style. Takes only a `CapabilityKey` — there is no
 * `note` prop — so a call site can never paper over a gap with invented
 * prose instead of the one recorded in `capabilities.ts`.
 *
 * See docs/design/waypoint-revamp-architecture.md §7.1.
 */
export function NotWired({ capability }: { capability: CapabilityKey }) {
  // Widened to `Capability` — the register's `as const` gives each entry a
  // literal type, and none of today's entries happen to be `'shipped'`, so
  // an unwidened comparison against it below would be flagged as
  // unreachable. The runtime check exists for exactly the day that stops
  // being true.
  const entry: Capability = CAPABILITIES[capability];

  if (process.env.NODE_ENV !== 'production' && entry.state === 'shipped') {
    // A 'shipped' capability has nothing to disclose — reaching this means
    // the register was flipped back to reality but the call site rendering
    // <NotWired/> for it was never removed.
    // eslint-disable-next-line no-console
    console.warn(
      `<NotWired capability="${capability}"/> was rendered for a 'shipped' capability. ` +
        'Remove this placeholder — the register says the promise is now kept.',
    );
  }

  return (
    <div
      role="status"
      data-capability={capability}
      data-capability-state={entry.state}
      title={entry.ref}
      className="flex items-start gap-2.5 rounded-[var(--radius-sm)] border border-warning/30 bg-warning-bg px-3 py-2 text-xs text-warning"
    >
      <IconAlert size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {entry.note ?? 'This is not wired up yet.'}
      </span>
    </div>
  );
}
