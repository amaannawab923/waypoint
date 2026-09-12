import { useEffect, useState } from 'react';
import { getHomeDir } from '@/data/engineApi';

let cached: string | null | undefined;

/** The home directory main reported, once per window; null until known or outside Electron. */
export function useHomeDir(): string | null {
  const [home, setHome] = useState<string | null>(cached ?? null);
  useEffect(() => {
    if (cached !== undefined) return undefined;
    let live = true;
    const read = async () => {
      let value: string | null = null;
      try {
        value = await getHomeDir();
      } catch {
        value = null;
      }
      cached = value;
      if (live) setHome(value);
    };
    read().catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return home;
}

/** Test seam. */
export function resetHomeDirForTests(): void {
  cached = undefined;
}
