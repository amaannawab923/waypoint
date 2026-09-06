import { useSyncExternalStore } from 'react';

// Whether the Copilot panel is currently mounted — read by any ticket drawer
// that needs to lay out around it (MY_JIRA_IMPROVEMENTS.md §5: a docked
// ticket drawer and a docked Copilot panel now both live on screen at once,
// and the drawer has to shift left by Copilot's width instead of sitting
// under it).
//
// AppShell.tsx already owns `copilotOpen` as real component state (it's a
// sibling of both <Outlet/> and <CopilotPanel/>) — the obvious next move
// would be react-router's `useOutletContext`, which this codebase already
// uses for exactly this shape of problem (see layouts/ProjectLayout.tsx's
// `useProject`). It doesn't work here: `useOutletContext` resolves against
// the NEAREST ancestor `<Outlet context=...>`, and ProjectLayout.tsx renders
// its own nested `<Outlet context={{ project, reloadProject }}>` for every
// project-scoped route. TicketDrawer.tsx is mounted from BOTH
// TicketsLayout.tsx (nested under ProjectLayout, where useOutletContext
// would silently return the project's context instead) and
// AllTicketsPage.tsx (mounted directly under AppShell's own outlet, where it
// would work) — the same component would read two different things
// depending on which route happened to open it. A module-level store
// side-steps route nesting entirely, the same way lib/proposalStore.ts and
// lib/toast.ts already do for "several independently-mounted surfaces need
// the same live value, wherever they're mounted."
type Listener = () => void;

let open = false;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Written only by AppShell.tsx, the sole owner of whether Copilot is mounted. */
export function setCopilotOpenState(value: boolean): void {
  if (open === value) return;
  open = value;
  notify();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return open;
}

/** Test-only escape hatch — same reasoning as proposalStore.ts's
 * resetProposalStoreForTests: this module is a singleton that outlives any
 * single `it()` block within a test file. */
export function resetCopilotOpenStateForTests(): void {
  open = false;
}

/** Live read of whether the Copilot panel is currently mounted. */
export function useCopilotOpenState(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
