import {
  registerActiveSelectableView,
  getActiveSelectableView,
  __resetActiveSelectableViewForTests,
} from './useActiveSelectableView';

beforeEach(() => {
  __resetActiveSelectableViewForTests();
});

describe('useActiveSelectableView registry', () => {
  it('has no active view registered by default', () => {
    expect(getActiveSelectableView()).toBeNull();
  });

  it('returns the most recently registered view', () => {
    const first = { selectAll: jest.fn(), clear: jest.fn() };
    const second = { selectAll: jest.fn(), clear: jest.fn() };

    registerActiveSelectableView(first);
    expect(getActiveSelectableView()).toBe(first);

    registerActiveSelectableView(second);
    expect(getActiveSelectableView()).toBe(second);
  });

  it("unregistering clears the active view when it's the current one", () => {
    const view = { selectAll: jest.fn(), clear: jest.fn() };
    const unregister = registerActiveSelectableView(view);

    unregister();

    expect(getActiveSelectableView()).toBeNull();
  });

  // Regression guard for out-of-order mount/unmount (e.g. React StrictMode's
  // dev-only mount→unmount→mount, or a new screen mounting fractionally
  // before the previous one's cleanup runs): a stale cleanup must not wipe
  // out a newer, still-mounted view's registration.
  it("a stale unregister call doesn't clobber a newer registration", () => {
    const first = { selectAll: jest.fn(), clear: jest.fn() };
    const second = { selectAll: jest.fn(), clear: jest.fn() };

    const unregisterFirst = registerActiveSelectableView(first);
    registerActiveSelectableView(second);

    unregisterFirst();

    expect(getActiveSelectableView()).toBe(second);
  });
});
