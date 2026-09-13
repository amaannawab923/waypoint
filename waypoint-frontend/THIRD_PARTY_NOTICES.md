# Third-party notices

Waypoint ships the following third-party software in addition to the npm
dependencies listed in `package.json` (whose licenses travel in
`node_modules` and in the packaged app's `LICENSES.chromium.html` /
`renderer.js.LICENSE.txt`).

## emdash — General Action, Inc. (Apache License 2.0)

Two unmodified builds from the emdash repository
(https://github.com/generalaction/emdash), both at commit `9b102a5f3`, both
`Copyright 2026 General Action, Inc.` and licensed under the Apache
License, Version 2.0:

| What | Pinned by | Fetched into | Used as |
|---|---|---|---|
| `apps/workspace-server` — the agent-session engine daemon | `engine.lock.json` (sha256) | `engine/` → extracted to the user's data directory at first use | A separate, supervised process; see `src/main/engine/` |
| `packages/chat-ui` (+ `@emdash/core` / `@emdash/shared` type declarations) — the session transcript UI | `chat-ui.lock.json` (sha256) | `vendor/emdash-chat-ui/` → bundled into `renderer.js` | The transcript renderer behind `src/renderer/components/chat/` |

The full license text and each archive's `NOTICE` are inside the archives
and are packaged with the app (`Resources/licenses/`, `Resources/engine/`).
Waypoint's own wrapper code around these builds (`src/main/engine/`,
`src/renderer/components/chat/ChatTranscript.tsx`) is Waypoint's, with
derivation from emdash's own wrapper noted in the file header where it
applies. Nothing in either build has been modified.
