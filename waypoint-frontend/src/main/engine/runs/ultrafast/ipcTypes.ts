/**
 * Ultrafast browser tasks — the IPC surface, in the same style as
 * `../../types.ts`'s `ENGINE_IPC`: channel names read from here everywhere
 * (never retyped), plain constants and types with no Electron or Node
 * import, so the renderer's `@/types/ultrafast` can re-export this file
 * directly (the same "nothing at runtime imports from main" reach
 * `@/types/engine` and `@/types/agentRuns` already make).
 */
export const ULTRAFAST_IPC = {
  /** → UltrafastStatus. Never throws — an unconfigured feature is a status, not an error. */
  status: 'ultrafast:get-status',
  /** (key: string) → UltrafastSaveKeyResult. */
  saveKey: 'ultrafast:save-key',
  /** () → { ok: true }. Idempotent. */
  clearKey: 'ultrafast:clear-key',
  /** () → UltrafastTestResult. Provisions if needed, self-tests the venv, then runs a real short task. */
  test: 'ultrafast:test',
} as const;

export interface UltrafastKeyStatus {
  configured: boolean;
  /** `…a1b2` — the last four characters only; the key itself never crosses IPC. */
  tail: string | null;
}

export interface UltrafastStatus {
  uvAvailable: boolean;
  provisioned: boolean;
  key: UltrafastKeyStatus;
  lastTest: UltrafastTestResult | null;
}

export type UltrafastSaveKeyResult =
  { ok: true; tail: string } | { ok: false; message: string };

export interface UltrafastTestResult {
  ok: boolean;
  /** The runner's own status word ('done' | 'blocked' | 'failed'), when the task ran far enough to report one. */
  status: string | null;
  steps: number | null;
  elapsedMs: number | null;
  /** A human sentence: the tool's own summary line, or why the test could not run. */
  message: string;
  /** The final page's screenshot, as a data: URL, when the task produced one. */
  screenshotDataUrl: string | null;
  testedAt: string;
}
