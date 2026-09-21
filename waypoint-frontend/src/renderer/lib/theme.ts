import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'waypoint:theme';

function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    // localStorage can throw in restricted contexts (private browsing, etc.)
    return 'light';
  }
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  // The vendored chat-ui picks its palette from an `emdark` / `emlight`
  // ancestor class (its own theme contract), so the two must travel together
  // — without this, session transcripts rendered chat-ui's light palette on
  // Waypoint's dark canvas. index.css then rebinds chat-ui's --chat-* tokens
  // to Waypoint's own under each theme; index.ejs mirrors this for first paint.
  root.classList.toggle('emdark', theme === 'dark');
  root.classList.toggle('emlight', theme !== 'dark');
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Toggle still works for the current session, it just won't persist.
  }
}

/**
 * Reads/writes the app's light/dark theme, applied via `data-theme` on
 * <html> (see index.css). The initial value is already on the page before
 * React even mounts — an inline script in index.ejs reads the same
 * localStorage key synchronously to avoid a flash of the wrong theme on
 * load — this hook just re-derives that same value into React state so the
 * toggle button can reflect and change it.
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function toggle() {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }

  return [theme, toggle];
}
