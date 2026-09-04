// Ports docs/design/waypoint-revamp-mockup.html's own hand-authored icon set
// (`const ICONS = {...}` / `function ic(name)`) into real React components, so
// screens that match a mockup icon render the exact same glyph instead of a
// visually-similar-but-different lucide-react one. Each icon keeps the
// mockup's own viewBox/stroke conventions verbatim — 24x24, stroke="currentColor"
// so it inherits text color like every other icon in the app, round
// linecap/linejoin, 2px stroke (2.2px for the handful the mockup marks
// `icon-sm`, which are also rendered slightly smaller by convention: 16px vs
// the default 18px, matching the mockup's `.icon`/`.icon-sm` CSS classes).
//
// lucide-react stays in use everywhere a screen needs a glyph outside this
// ~33-icon set — it shares the same outline aesthetic (24x24, ~2px stroke,
// rounded caps), so a mixed icon set doesn't read as inconsistent.

import type { CSSProperties, ReactNode } from 'react';

export interface IconProps {
  size?: number;
  className?: string;
  strokeWidth?: number;
  /** Per-instance color override (e.g. a ticket state's own color) — the
   * glyph otherwise inherits `currentColor` from surrounding text. */
  style?: CSSProperties;
}

function makeIcon(path: ReactNode, defaultSize = 18, defaultStrokeWidth = 2) {
  return function Icon({ size = defaultSize, className, strokeWidth = defaultStrokeWidth, style }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={style}
        aria-hidden="true"
      >
        {path}
      </svg>
    );
  };
}

export const IconHome = makeIcon(
  <>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
  </>,
);

export const IconUser = makeIcon(
  <>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c0-3.5 3.2-6 7-6s7 2.5 7 6" />
  </>,
);

export const IconBell = makeIcon(
  <>
    <path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10Z" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </>,
);

export const IconEdit = makeIcon(<path d="M4 20h4L18.5 9.5a2 2 0 0 0-4-4L4 16z" />);

export const IconScratch = makeIcon(
  <>
    <path d="M4.5 4.5h15v10l-5 5h-10z" />
    <path d="M19.5 14.5h-5v5" />
    <path d="M8 9h8M8 12.5h5" />
  </>,
);

export const IconReview = makeIcon(
  <>
    <path d="m3 13 3.5 3.5L13 10" />
    <path d="m11 16.5 2 2L21 10" />
  </>,
);

export const IconPlus = makeIcon(<path d="M12 5v14M5 12h14" />, 16);

export const IconFolder = makeIcon(
  <path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h9a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17z" />,
);

export const IconLayers = makeIcon(
  <>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 13 9 5 9-5" />
  </>,
);

export const IconList = makeIcon(
  <>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none" />
  </>,
);

export const IconRefresh = makeIcon(
  <>
    <path d="M4 12a8 8 0 0 1 14-5.3L21 9" />
    <path d="M21 4v5h-5" />
    <path d="M20 12a8 8 0 0 1-14 5.3L3 15" />
    <path d="M3 20v-5h5" />
  </>,
);

export const IconTrack = makeIcon(
  <>
    <path d="M4 5v6a3 3 0 0 0 3 3h13" />
    <circle cx="4" cy="5" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="20" cy="14" r="1.6" fill="currentColor" stroke="none" />
    <path d="M20 14v5" />
  </>,
);

export const IconEye = makeIcon(
  <>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

export const IconInbox = makeIcon(
  <>
    <path d="M4 12h4l2 3h4l2-3h4" />
    <path d="M4 12 5.5 5a1 1 0 0 1 1-.8h11a1 1 0 0 1 1 .8L20 12v5.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
  </>,
);

export const IconFile = makeIcon(
  <>
    <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v4h4" />
    <path d="M9 13h6M9 16.5h6" />
  </>,
);

export const IconSettings = makeIcon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M4.2 7l2.2 1.3M17.6 15.7l2.2 1.3M3 12h2.5M18.5 12H21M4.2 17l2.2-1.3M17.6 8.3l2.2-1.3" />
  </>,
);

export const IconGitBranch = makeIcon(
  <>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="9" r="2" />
    <path d="M6 7v10M6 12c0-3.5 3-3.5 6.5-3.5H15" />
  </>,
  16,
);

export const IconChevronRight = makeIcon(<path d="m9 5 7 7-7 7" />, 16);
export const IconChevron = makeIcon(<path d="m5 9 7 7 7-7" />, 16);

export const IconArchive = makeIcon(
  <>
    <rect x="3.5" y="4" width="17" height="4" rx="1" />
    <path d="M5 8v10a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V8" />
    <path d="M10 12.5h4" />
  </>,
);

export const IconChart = makeIcon(<path d="M5 19V10M12 19V5M19 19v-7" />);

export const IconSearch = makeIcon(
  <>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="m20 20-4.4-4.4" />
  </>,
);

export const IconSun = makeIcon(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
  </>,
);

export const IconKeyboard = makeIcon(
  <>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8" />
  </>,
);

// The one icon whose mockup stroke-width is 1.8, not 2.
export const IconSparkles = makeIcon(
  <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" />,
  18,
  1.8,
);

export const IconCircle = makeIcon(<circle cx="12" cy="12" r="8" />);
export const IconCircleDot = makeIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
  </>,
);
export const IconDashed = makeIcon(<circle cx="12" cy="12" r="8" strokeDasharray="2.6 3.2" />);
export const IconCheck = makeIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="m9 12 2 2 4-4" />
  </>,
);
export const IconXCircle = makeIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="m9.5 9.5 5 5M14.5 9.5l-5 5" />
  </>,
);

export const IconBot = makeIcon(
  <>
    <rect x="4" y="9" width="16" height="11" rx="2.5" />
    <path d="M12 5.5V9" />
    <circle cx="12" cy="4" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="9" cy="14.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="14.5" r="1.1" fill="currentColor" stroke="none" />
  </>,
);

export const IconFilter = makeIcon(<path d="M3.5 5h17l-6.5 7.5V20l-4-2.5v-5z" />, 16);

export const IconShield = makeIcon(
  <>
    <path d="M12 3 5 6v6c0 4.4 3 7.6 7 9 4-1.4 7-4.6 7-9V6z" />
    <path d="m9.5 12 2 2 3.5-4" />
  </>,
);

export const IconLock = makeIcon(
  <>
    <rect x="5" y="10.5" width="14" height="9" rx="1.5" />
    <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
  </>,
);

export const IconKey = makeIcon(
  <>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8-8M16 5l2.5 2.5M13 8l2 2" />
  </>,
);

export const IconMessage = makeIcon(<path d="M4 5.5h16v11H9l-4 3.5v-3.5H4z" />);

export const IconClock = makeIcon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </>,
);

export const IconX = makeIcon(<path d="M6 6l12 12M18 6 6 18" />, 16);

export const IconPanel = makeIcon(
  <>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M9.5 4.5v15" />
  </>,
  16,
);

export const IconPin = makeIcon(
  <>
    <path d="M15 3.5 20.5 9l-3 1-4.5 4.5-1 4-6-6 4-1L14.5 6.5z" />
    <path d="m6 18-2.5 2.5" />
  </>,
  16,
);

export const IconAlert = makeIcon(
  <>
    <path d="M12 4.5 21 19.5H3z" />
    <path d="M12 10v4M12 16.8h.01" />
  </>,
);
