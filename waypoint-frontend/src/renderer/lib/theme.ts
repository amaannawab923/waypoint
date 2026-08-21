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
  document.documentElement.setAttribute('data-theme', theme);
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
