import {
  activeProjectIdFrom,
  isProjectOpen,
  resetSidebarProjectsForTests,
  setProjectOpen,
} from './sidebarProjects';

beforeEach(() => resetSidebarProjectsForTests());

describe('isProjectOpen', () => {
  it('a project starts folded, except the one the route is inside', () => {
    expect(isProjectOpen({}, 'proj-cw', null)).toBe(false);
    expect(isProjectOpen({}, 'proj-cw', 'proj-cw')).toBe(true);
    expect(isProjectOpen({}, 'proj-pl', 'proj-cw')).toBe(false);
  });

  it('a remembered choice wins over the route, either way', () => {
    expect(isProjectOpen({ 'proj-cw': false }, 'proj-cw', 'proj-cw')).toBe(
      false,
    );
    expect(isProjectOpen({ 'proj-pl': true }, 'proj-pl', 'proj-cw')).toBe(true);
  });
});

describe('setProjectOpen', () => {
  it('remembers across a reload and survives garbage in storage', () => {
    setProjectOpen('proj-pl', true);
    expect(
      JSON.parse(localStorage.getItem('waypoint:sidebar-projects')!),
    ).toEqual({
      'proj-pl': true,
    });
    localStorage.setItem('waypoint:sidebar-projects', '[1,2]');
    resetSidebarProjectsForTests();
    expect(isProjectOpen({}, 'proj-pl', null)).toBe(false);
  });
});

describe('activeProjectIdFrom', () => {
  it('reads the project out of a project route and nothing else', () => {
    expect(activeProjectIdFrom('/projects/proj-cw/tickets')).toBe('proj-cw');
    expect(activeProjectIdFrom('/projects/proj-cw')).toBe('proj-cw');
    expect(activeProjectIdFrom('/projects')).toBeNull();
    expect(activeProjectIdFrom('/projects/archived')).toBeNull();
    expect(activeProjectIdFrom('/sessions/run-1')).toBeNull();
  });
});
