import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { clsx } from 'clsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-accent bg-[image:var(--accent-gradient)] text-on-accent shadow-sm hover:brightness-125',
  secondary: 'bg-surface border border-border-strong text-text hover:bg-surface-2',
  ghost: 'bg-transparent text-text-secondary hover:bg-surface-2 hover:text-text',
  danger: 'bg-danger text-white hover:brightness-110',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  xs: 'h-6 px-2 text-xs gap-1',
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
};

export function Button({
  variant = 'secondary',
  size = 'sm',
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={clsx(
        'inline-flex cursor-pointer items-center justify-center rounded-[var(--radius-sm)] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function IconButton({
  className,
  children,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={clsx(
        'inline-flex size-7 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
