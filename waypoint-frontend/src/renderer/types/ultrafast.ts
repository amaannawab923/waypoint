// Renderer-facing mirror of Ultrafast browser tasks' IPC contract
// (main/engine/runs/ultrafast/ipcTypes.ts) — the same type-only reach into
// src/main that `@/types/engine` and `@/types/agentRuns` make (see either
// file's own header). Nothing at runtime imports from main.
export type {
  UltrafastKeyStatus,
  UltrafastSaveKeyResult,
  UltrafastStatus,
  UltrafastTestResult,
} from '../../main/engine/runs/ultrafast/ipcTypes';
