import { renderHook, waitFor } from '@testing-library/react';
import { listProjects } from '@/mock/api';
import type { Project } from '@/types/entities';
import { useRepoSuggestions } from './useRepoSuggestions';

jest.mock('@/mock/api', () => ({ listProjects: jest.fn() }));

function project(over: Partial<Project> & { id: string; name: string }): Project {
  return {
    workspaceId: 'ws-1',
    identifier: over.name.slice(0, 4).toUpperCase(),
    description: '',
    icon: '📦',
    coverGradient: ['#000', '#111'],
    network: 'public',
    leadId: null,
    defaultAssigneeId: null,
    timezone: 'UTC',
    features: { cycles: true, modules: true, views: true, pages: true, intake: true },
    estimate: null,
    automations: {
      autoArchiveEnabled: false,
      autoArchiveAfterDays: 30,
      autoCloseEnabled: false,
      autoCloseAfterDays: 30,
    },
    createdAt: new Date().toISOString(),
    archivedAt: null,
    memberIds: [],
    guestAccessEnabled: false,
    repoPath: null,
    ...over,
  } as Project;
}

function suggestFor(projects: Project[], name = 'Waypoint', identifier = 'WPT') {
  jest.mocked(listProjects).mockResolvedValue(projects);
  return renderHook(() => useRepoSuggestions('proj-current', name, identifier));
}

beforeEach(() => {
  jest.mocked(listProjects).mockReset();
});

describe('useRepoSuggestions', () => {
  it('offers nothing at all when no other project has a repo linked', async () => {
    const { result } = suggestFor([
      project({ id: 'proj-current', name: 'Waypoint' }),
      project({ id: 'p2', name: 'Atlas' }),
    ]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.suggestions).toEqual([]);
  });

  it('never suggests the current project back to itself', async () => {
    const { result } = suggestFor([
      project({ id: 'proj-current', name: 'Waypoint', repoPath: '/code/waypoint' }),
    ]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.suggestions).toEqual([]);
  });

  it('labels a basename that matches the project name as a name-match', async () => {
    const { result } = suggestFor([
      project({ id: 'p2', name: 'Old Waypoint', repoPath: '/Users/a/code/waypoint-electron-v3' }),
    ]);

    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
    expect(result.current.suggestions[0]).toEqual({
      path: '/Users/a/code/waypoint-electron-v3',
      name: 'waypoint-electron-v3',
      reason: 'name-match',
    });
  });

  it("labels an unrelated repo with the other project's name instead", async () => {
    const { result } = suggestFor([
      project({ id: 'p2', name: 'Atlas', repoPath: '/Users/a/code/billing-service' }),
    ]);

    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
    expect(result.current.suggestions[0]).toEqual({
      path: '/Users/a/code/billing-service',
      name: 'billing-service',
      reason: 'other-project',
      otherProjectName: 'Atlas',
    });
  });

  it('sorts name matches first — the highest-confidence pick', async () => {
    const { result } = suggestFor([
      project({ id: 'p2', name: 'Atlas', repoPath: '/code/atlas-api' }),
      project({ id: 'p3', name: 'Old', repoPath: '/code/waypoint' }),
    ]);

    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
    expect(result.current.suggestions.map((s) => s.name)).toEqual([
      'waypoint',
      'atlas-api',
    ]);
  });

  // Two projects legitimately pointing at one checkout (a monorepo split
  // across projects) should offer it once, not twice.
  it('de-duplicates a path shared by two other projects', async () => {
    const { result } = suggestFor([
      project({ id: 'p2', name: 'Atlas', repoPath: '/code/monorepo' }),
      project({ id: 'p3', name: 'Beacon', repoPath: '/code/monorepo' }),
    ]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.suggestions).toHaveLength(1);
    expect(result.current.suggestions[0].otherProjectName).toBe('Atlas');
  });

  it('matches on the project identifier too, not just its name', async () => {
    const { result } = suggestFor(
      [project({ id: 'p2', name: 'Something Else', repoPath: '/code/wpt-server' })],
      'Totally Different',
      'WPT',
    );

    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
    expect(result.current.suggestions[0].reason).toBe('name-match');
  });

  it('survives a failed projects fetch with an empty list rather than throwing', async () => {
    jest.mocked(listProjects).mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useRepoSuggestions('proj-current', 'Waypoint', 'WPT'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.suggestions).toEqual([]);
  });
});
