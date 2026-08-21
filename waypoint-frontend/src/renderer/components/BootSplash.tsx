import { useEffect, useState } from 'react';

const HOLD_MS = 3200;
const EXIT_MS = 500;

/**
 * One-time-per-launch branded overlay, mounted above the router in App.tsx.
 * The router resolves its real first screen underneath immediately — this
 * doesn't gate data loading, it's purely a curtain that lifts after a fixed
 * hold so the app never feels like it's blocking on the animation.
 */
export function BootSplash({ onFinish }: { onFinish: () => void }) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const exitTimer = setTimeout(() => setExiting(true), HOLD_MS);
    const finishTimer = setTimeout(() => onFinish(), HOLD_MS + EXIT_MS);
    return () => {
      clearTimeout(exitTimer);
      clearTimeout(finishTimer);
    };
  }, [onFinish]);

  return (
    <div className="boot-overlay" data-exiting={exiting} aria-hidden="true">
      <div className="flex flex-col items-center">
        <svg width="56" height="56" viewBox="0 0 64 64" fill="none">
          <path
            className="boot-mark-path"
            d="M32 5 L59 32 L32 59 L5 32 Z"
            stroke="var(--on-accent)"
            strokeWidth="2.5"
            strokeLinejoin="round"
            pathLength="1"
          />
          <circle className="boot-mark-dot" cx="32" cy="32" r="5" fill="var(--on-accent)" />
        </svg>

        <h1 className="boot-wordmark mt-5 font-display text-2xl font-semibold tracking-tight text-on-accent">
          Waypoint
        </h1>
        <p className="boot-tagline mt-1.5 text-sm text-white/50">Plan, track, and ship your work.</p>
      </div>
    </div>
  );
}
