# Waypoint — Frontend (Electron desktop app)

The native Electron + React client for Waypoint. This is what actually runs on a
user's machine as a real desktop app — not a web page wrapped in a browser tab.

See the [root README](../README.md) for the product pitch and how this fits
together with [`waypoint-backend`](../waypoint-backend).

## Stack

- Electron + React 19, built on the `electron-react-boilerplate` toolchain
  (webpack, hot reload for both the renderer and the main process)
- React Router (`createBrowserRouter`) for real, address-bar-updating routes
- Tailwind CSS for styling
- Talks to `waypoint-backend`'s REST API over `WAYPOINT_API_BASE_URL`
  (defaults to `http://localhost:14000`)

## Getting started

```bash
npm install
npm start
```

`npm start` boots webpack-dev-server for the renderer and launches the Electron
shell together, with hot reload on both sides. Make sure `waypoint-backend` is
running first (see its own README) — this app has no built-in mock/offline mode.

## Building a packaged app

```bash
npm run package
```

Produces a signed, installable build under `release/build/` for the current
platform (macOS `.dmg`/`.zip`, or the equivalent on Windows/Linux).

## Project layout

```
src/
  main/       Electron main process — window lifecycle, the custom app://
              protocol handler that serves the packaged build with SPA
              fallback routing, auto-update wiring
  entry/      main.ts / preload.ts entry points
  renderer/
    components/   Shared UI primitives (Button, Modal, Avatar, DatePicker, …)
                   and domain components (WorkItemDrawer, CreateWorkItemModal, …)
    pages/         One folder per top-level view (work-items, project-settings,
                    workspace-settings, profile-settings, admin, …)
    layouts/        AppShell, ProjectLayout — the chrome each page renders inside
    lib/            Small focused helpers (toast, recents, markdown, …)
    data/           The HTTP client that talks to waypoint-backend, plus
                     shared types/current-user constants
    router.tsx      The full route table
```
