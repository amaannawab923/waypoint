import type { HTMLAttributes, ReactNode } from 'react';
import { clsx } from 'clsx';

type SkeletonProps = HTMLAttributes<HTMLDivElement> & { children?: ReactNode };

export function Skeleton({ children, className, ...props }: SkeletonProps) {
  return (
    <div className={clsx('animate-pulse', className)} role="status" {...props}>
      {children}
    </div>
  );
}

type SkeletonBlockProps = {
  height?: string;
  width?: string;
  rounded?: string;
  className?: string;
};

function SkeletonBlock({ height = '1rem', width = '100%', rounded, className }: SkeletonBlockProps) {
  return (
    <div className={clsx('bg-surface-2', rounded ?? 'rounded-md', className)} style={{ height, width }} />
  );
}

type SkeletonCircleProps = {
  size?: string;
  className?: string;
};

function SkeletonCircle({ size = '2rem', className }: SkeletonCircleProps) {
  return <SkeletonBlock height={size} width={size} rounded="rounded-full" className={className} />;
}

Skeleton.Block = SkeletonBlock;
Skeleton.Circle = SkeletonCircle;

const TITLE_WIDTHS = ['w-32', 'w-48', 'w-64'];

export function SkeletonListRows({ rows = 6 }: { rows?: number }) {
  return (
    <Skeleton>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className={clsx('flex items-center gap-3 px-2 py-3', index > 0 && 'border-t border-border')}
        >
          <Skeleton.Block height="1.25rem" width="40px" rounded="rounded-sm" />
          <Skeleton.Block height="0.875rem" className={TITLE_WIDTHS[index % TITLE_WIDTHS.length]} />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton.Block height="1.25rem" width="4rem" rounded="rounded-sm" />
            <Skeleton.Block height="1.25rem" width="4rem" rounded="rounded-sm" />
            <Skeleton.Circle size="1.5rem" />
          </div>
        </div>
      ))}
    </Skeleton>
  );
}

export function SkeletonCardGrid({ cards = 6 }: { cards?: number }) {
  return (
    <Skeleton className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: cards }).map((_, index) => (
        <div
          key={index}
          className="overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface"
        >
          <div className="relative h-24 bg-surface-2">
            <div className="absolute bottom-3 left-3 flex items-center gap-2">
              <Skeleton.Circle size="1.5rem" />
              <Skeleton.Block height="0.75rem" width="5rem" className="bg-surface" />
            </div>
          </div>
          <div className="space-y-2 p-4">
            <Skeleton.Block height="0.875rem" className={TITLE_WIDTHS[index % TITLE_WIDTHS.length]} />
            <Skeleton.Block height="0.75rem" width="60%" />
            <Skeleton.Block height="0.75rem" width="40%" />
          </div>
        </div>
      ))}
    </Skeleton>
  );
}

export function SkeletonTableRows({ rows = 4, columns = 4 }: { rows?: number; columns?: number }) {
  const trailingColumns = Math.max(columns - 1, 0);
  return (
    <Skeleton>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
          key={rowIndex}
          className={clsx('flex items-center gap-4 px-2 py-3', rowIndex > 0 && 'border-t border-border')}
        >
          <div className="flex flex-1 items-center gap-3">
            <Skeleton.Circle size="2rem" />
            <Skeleton.Block height="0.875rem" className={TITLE_WIDTHS[rowIndex % TITLE_WIDTHS.length]} />
          </div>
          {Array.from({ length: trailingColumns }).map((_, colIndex) => (
            <Skeleton.Block
              key={colIndex}
              height="0.75rem"
              width="5rem"
              className="flex-1"
            />
          ))}
        </div>
      ))}
    </Skeleton>
  );
}
