import { useAsync } from '@/lib/useAsync';
import { detectLocalClaudeCode, listProjects } from '@/data/api';

/**
 * The sidebar's Local strip, as facts: how many projects have a linked
 * repo and whether the Claude CLI was detected — and the one sentence both
 * render from ("Local · 3 repos · Claude ready"). Shared by the full
 * sidebar's strip (Sidebar.tsx) and the rail's dot (SidebarRail.tsx,
 * W3), which has room for a tooltip, not a strip.
 */
export function useLocalSummary(): {
  repoCount: number;
  claudeReady: boolean;
  sentence: string;
} {
  const { data: projects } = useAsync(() => listProjects(), []);
  const { data: claude } = useAsync(() => detectLocalClaudeCode(), []);
  const repoCount = (projects ?? []).filter((p) => p.repoPath).length;
  const claudeReady = claude?.state === 'present';
  return {
    repoCount,
    claudeReady,
    sentence: `Local · ${repoCount} repo${repoCount === 1 ? '' : 's'} · ${
      claudeReady ? 'Claude ready' : 'Claude not detected'
    }`,
  };
}
