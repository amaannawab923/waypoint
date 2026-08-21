import type { ReactNode } from 'react';
import { clsx } from 'clsx';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-text-secondary',
  accent: 'bg-accent-soft-bg text-accent-soft-text',
  success: 'bg-success-bg text-success',
  warning: 'bg-warning-bg text-warning',
  danger: 'bg-danger-bg text-danger',
  info: 'bg-info-bg text-info',
};

export function Badge({
  tone = 'neutral',
  outline = false,
  children,
  className,
}: {
  tone?: BadgeTone;
  outline?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        outline ? 'border border-border-strong bg-transparent text-text-secondary' : TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ color, className }: { color: string; className?: string }) {
  return <span className={clsx('inline-block size-2 shrink-0 rounded-full', className)} style={{ background: color }} />;
}
