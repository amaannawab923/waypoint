import { clsx } from 'clsx';
import type { LucideIcon } from 'lucide-react';

/**
 * A bordered pill with an icon AND a text label — never an unlabelled
 * icon button. Matches the comment surface's own action-chip treatment
 * (its Reply pill: "↩ Reply", always visible, never hover-revealed): every
 * action AttachmentTray/AttachmentList expose (retry, cancel, remove,
 * download, delete) renders this way, not as an icon hidden behind a
 * tooltip.
 */
export function AttachmentActionChip({
  icon: Icon,
  label,
  ariaLabel,
  onClick,
  href,
  download,
  danger,
  disabled,
}: {
  icon: LucideIcon;
  /** Visible text — kept short ("Retry", "Delete"). */
  label: string;
  /** Longer accessible name when the short visible label is ambiguous with
   *  several items in a list (e.g. "Retry uploading screenshot.png" instead
   *  of a bare "Retry" every item shares). Falls back to `label`. */
  ariaLabel?: string;
  onClick?: () => void;
  /** Renders as an <a> instead of a <button> — for a real download link
   *  that needs no JS to work. */
  href?: string;
  download?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const accessibleName = ariaLabel ?? label;
  const className = clsx(
    'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap transition-colors',
    danger
      ? 'border-danger/40 text-danger hover:bg-danger-bg'
      : 'border-border text-text-secondary hover:border-border-strong hover:bg-surface-2 hover:text-text',
    disabled && 'pointer-events-none cursor-not-allowed opacity-50',
  );

  if (href) {
    return (
      <a href={href} download={download} aria-label={accessibleName} className={className}>
        <Icon size={11} aria-hidden="true" />
        {label}
      </a>
    );
  }

  return (
    <button type="button" aria-label={accessibleName} disabled={disabled} onClick={onClick} className={className}>
      <Icon size={11} aria-hidden="true" />
      {label}
    </button>
  );
}
