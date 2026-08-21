import { clsx } from 'clsx';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({
  name,
  color = 'var(--accent)',
  size = 24,
  shape = 'circle',
  className,
}: {
  name: string;
  color?: string;
  size?: number;
  /** 'square' marks an agent identity — the human/agent visual tell used everywhere assignees appear. */
  shape?: 'circle' | 'square';
  className?: string;
}) {
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center justify-center font-medium',
        shape === 'circle' ? 'rounded-full' : 'rounded-[6px]',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, size * 0.4),
        background: color,
        color: 'var(--on-accent)',
      }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

export function AvatarStack({
  people,
  size = 22,
  max = 3,
}: {
  people: { name: string; color?: string; shape?: 'circle' | 'square' }[];
  size?: number;
  max?: number;
}) {
  const shown = people.slice(0, max);
  const overflow = people.length - shown.length;
  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((p, i) => (
        <Avatar
          key={`${p.name}-${i}`}
          name={p.name}
          color={p.color}
          shape={p.shape}
          size={size}
          className="ring-2 ring-[var(--surface)]"
        />
      ))}
      {overflow > 0 && (
        <span
          className="inline-flex shrink-0 items-center justify-center rounded-full font-medium ring-2 ring-[var(--surface)]"
          style={{
            width: size,
            height: size,
            fontSize: Math.max(9, size * 0.38),
            background: 'var(--surface-2)',
            color: 'var(--text-secondary)',
          }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
