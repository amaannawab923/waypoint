import { act, renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  resetCopilotPanelWidthForTests,
  useCopilotPanelResizingState,
  useCopilotPanelWidth,
  useCopilotPanelWidthState,
} from './useCopilotPanelWidth';

const STORAGE_KEY = 'waypoint:copilot-panel-width';

// PointerEvent isn't implemented in this project's jsdom environment — the
// hook's own listeners only ever read `.clientX` (pointermove) or nothing at
// all (pointerup/pointercancel), so a plain MouseEvent dispatched under the
// 'pointermove'/'pointerup'/'pointercancel' TYPE is indistinguishable to
// them from a real PointerEvent; dispatch just matches by event.type string,
// not by constructor.
function firePointerMove(clientX: number) {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX }));
}
function firePointerUp() {
  window.dispatchEvent(new MouseEvent('pointerup'));
}
function firePointerCancel() {
  window.dispatchEvent(new MouseEvent('pointercancel'));
}
function fakePointerDown(clientX: number, button = 0) {
  return {
    button,
    clientX,
    preventDefault: jest.fn(),
  } as unknown as ReactPointerEvent;
}

beforeEach(() => {
  localStorage.clear();
  resetCopilotPanelWidthForTests();
});

describe('useCopilotPanelWidth', () => {
  it('defaults to DEFAULT_PANEL_WIDTH with nothing stored', () => {
    const { result } = renderHook(() => useCopilotPanelWidth());

    expect(result.current.width).toBe(DEFAULT_PANEL_WIDTH);
    expect(result.current.isResizing).toBe(false);
  });

  it('reads a previously stored width on mount', () => {
    // sharedWidth hydrates once, at module load — setting localStorage
    // alone does nothing to an already-running module, exactly like a real
    // app doesn't re-read localStorage mid-session either. Re-running the
    // reset is what stands in for "the module just loaded", the same
    // moment a real app actually reads storage.
    localStorage.setItem(STORAGE_KEY, '550');
    resetCopilotPanelWidthForTests();

    const { result } = renderHook(() => useCopilotPanelWidth());

    expect(result.current.width).toBe(550);
  });

  // The panel is pinned to the right edge, so dragging the handle LEFT (a
  // negative clientX delta) must WIDEN it — the one bit of sign-flipping
  // math in the whole hook, and the thing most likely to silently invert
  // itself in a future edit.
  it('widens the panel when the pointer moves left, narrows when it moves right', () => {
    const { result } = renderHook(() => useCopilotPanelWidth());

    act(() => {
      result.current.startResize(fakePointerDown(500));
    });
    expect(result.current.isResizing).toBe(true);

    act(() => firePointerMove(400)); // 100px left
    expect(result.current.width).toBe(DEFAULT_PANEL_WIDTH + 100);

    act(() => firePointerMove(450)); // back 50px right of the low point
    expect(result.current.width).toBe(DEFAULT_PANEL_WIDTH + 50);

    act(() => firePointerUp());
    expect(result.current.isResizing).toBe(false);
  });

  it('clamps at MIN_PANEL_WIDTH and MAX_PANEL_WIDTH rather than going past them', () => {
    const { result } = renderHook(() => useCopilotPanelWidth());

    act(() => {
      result.current.startResize(fakePointerDown(500));
    });
    act(() => firePointerMove(500 + 10_000)); // drag far right
    expect(result.current.width).toBe(MIN_PANEL_WIDTH);

    act(() => firePointerUp());
    act(() => {
      result.current.startResize(fakePointerDown(500));
    });
    act(() => firePointerMove(500 - 10_000)); // drag far left
    expect(result.current.width).toBe(MAX_PANEL_WIDTH);
  });

  it('persists the final width to localStorage once the drag ends, not on every move', () => {
    const { result } = renderHook(() => useCopilotPanelWidth());

    act(() => {
      result.current.startResize(fakePointerDown(500));
    });
    act(() => firePointerMove(400));
    expect(localStorage.getItem(STORAGE_KEY)).toBe(String(DEFAULT_PANEL_WIDTH));

    act(() => firePointerUp());
    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      String(DEFAULT_PANEL_WIDTH + 100),
    );
  });

  it('ignores a right-click on the handle — no drag starts', () => {
    const { result } = renderHook(() => useCopilotPanelWidth());

    act(() => {
      result.current.startResize(fakePointerDown(500, /* button */ 2));
    });
    expect(result.current.isResizing).toBe(false);

    act(() => firePointerMove(300));
    expect(result.current.width).toBe(DEFAULT_PANEL_WIDTH);
  });

  it('ends the drag on pointercancel the same way pointerup does', () => {
    const { result } = renderHook(() => useCopilotPanelWidth());

    act(() => {
      result.current.startResize(fakePointerDown(500));
    });
    act(() => firePointerMove(400));
    act(() => firePointerCancel());

    expect(result.current.isResizing).toBe(false);
    // The width reached before the cancel is kept, not rolled back — a
    // cancelled gesture still ends wherever the pointer last was.
    expect(result.current.width).toBe(DEFAULT_PANEL_WIDTH + 100);
  });

  // Regression: this component unmounting mid-drag (the panel closes, a
  // route change, an HMR reload in dev) used to leave the SHARED resizing
  // flag stuck at true forever, since only pointerup/pointercancel ever
  // cleared it — and nothing else in the app ever calls that. Both ticket
  // drawers read this flag to decide whether to animate their own `right`
  // offset; stuck at true, they'd silently stop animating open/close for
  // the rest of the session.
  it('clears the shared "is resizing" flag if the component unmounts mid-drag', () => {
    const widthHook = renderHook(() => useCopilotPanelWidth());
    const resizingHook = renderHook(() => useCopilotPanelResizingState());

    act(() => {
      widthHook.result.current.startResize(fakePointerDown(500));
    });
    expect(resizingHook.result.current).toBe(true);

    act(() => widthHook.unmount());

    expect(resizingHook.result.current).toBe(false);
  });

  it('shares its live width with useCopilotPanelWidthState, the read-only hook the ticket drawers use', () => {
    const widthHook = renderHook(() => useCopilotPanelWidth());
    const readerHook = renderHook(() => useCopilotPanelWidthState());

    expect(readerHook.result.current).toBe(DEFAULT_PANEL_WIDTH);

    act(() => {
      widthHook.result.current.startResize(fakePointerDown(500));
    });
    act(() => firePointerMove(350)); // 150px left

    expect(readerHook.result.current).toBe(DEFAULT_PANEL_WIDTH + 150);
  });
});
