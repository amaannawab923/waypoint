import {
  isJiraStarred,
  listJiraStarredKeys,
  resetJiraStarredForTests,
  toggleJiraStarred,
} from './jiraStarred';

beforeEach(() => {
  localStorage.clear();
  resetJiraStarredForTests();
});

describe('jiraStarred', () => {
  it('starts with nothing starred', () => {
    expect(isJiraStarred('ENG-1')).toBe(false);
    expect(listJiraStarredKeys()).toEqual([]);
  });

  it('toggling stars a key and returns the new state', () => {
    const result = toggleJiraStarred('ENG-1');

    expect(result).toBe(true);
    expect(isJiraStarred('ENG-1')).toBe(true);
    expect(listJiraStarredKeys()).toEqual(['ENG-1']);
  });

  it('toggling a starred key unstars it', () => {
    toggleJiraStarred('ENG-1');

    const result = toggleJiraStarred('ENG-1');

    expect(result).toBe(false);
    expect(isJiraStarred('ENG-1')).toBe(false);
    expect(listJiraStarredKeys()).toEqual([]);
  });

  it('tracks multiple keys independently', () => {
    toggleJiraStarred('ENG-1');
    toggleJiraStarred('PLAT-2');

    expect(listJiraStarredKeys().sort()).toEqual(['ENG-1', 'PLAT-2']);

    toggleJiraStarred('ENG-1');

    expect(listJiraStarredKeys()).toEqual(['PLAT-2']);
  });

  it('persists across a fresh read of the module-level cache (survives a reload)', () => {
    toggleJiraStarred('ENG-1');

    // Simulate a fresh page load: nothing but localStorage survives.
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const reloaded = require('./jiraStarred') as typeof import('./jiraStarred');

    expect(reloaded.isJiraStarred('ENG-1')).toBe(true);
  });

  // A corrupted or foreign value under this key must not crash the reader —
  // same discipline recents.ts's own readRecents follows.
  it('treats malformed localStorage content as nothing starred, not a crash', () => {
    localStorage.setItem('waypoint:jira-starred', 'not json');
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const reloaded = require('./jiraStarred') as typeof import('./jiraStarred');

    expect(reloaded.listJiraStarredKeys()).toEqual([]);
  });
});
