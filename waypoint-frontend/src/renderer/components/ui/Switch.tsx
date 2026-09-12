import { clsx } from 'clsx';

/**
 * A two-state switch (`role="switch"`), the New session dialog's
 * auto-approve control made shared for W5a's other two: the brief
 * preview's auto-approve and *Something else…*'s "may change files". The
 * knob sits inside the pill in both states (`left-0` plus the translate),
 * with a ring so it reads on the accent as on the border.
 */
export function Switch({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  /** The accessible name; the visible label is the caller's `<label htmlFor>`. */
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-border-strong',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 left-0 size-4 rounded-full bg-bg shadow ring-1 ring-border transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
