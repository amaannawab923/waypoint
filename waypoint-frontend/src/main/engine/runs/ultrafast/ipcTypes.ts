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
  /** Where the key in use came from: the settings page's encrypted store, or
   *  `TYPESAFE_API_KEY` in the environment / the app's `.env`. Null when unconfigured. */
  source: 'settings' | 'env' | null;
}

export interface UltrafastStatus {
  uvAvailable: boolean;
  provisioned: boolean;
  /** F19 (tech-lead review, 2026-09-22): whether this install's copy of
   *  `ultrafast-mcp.js`/`runner.py` exist — `ultrafastAvailability()`
   *  (registration.ts) already computed this fact, but it never reached
   *  the renderer, so a missing-scripts install (a bad build, extraResources
   *  not copied) could satisfy every other gate and still never explain why
   *  the tool never shows up in a session. */
  scriptsInstalled: boolean;
  /** F19: whether the daemon actually has `browser_task` registered right
   *  now — registration.ts's own `isUltrafastRegistered()`. The other
   *  fields here can all be true (key saved, uv present, provisioned,
   *  scripts installed) while this is still false, in the window before
   *  registration has actually run against a live daemon connection; only
   *  this field means a session started right now would see the tool. */
  registered: boolean;
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
