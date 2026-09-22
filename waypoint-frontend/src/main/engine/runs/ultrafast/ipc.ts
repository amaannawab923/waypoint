import * as fs from 'fs';
import { app, ipcMain } from 'electron';
import {
  deleteStoredTypesafeApiKey,
  isUltrafastSecureStorageAvailable,
  maskedTail,
  resolveTypesafeApiKey,
  writeStoredTypesafeApiKey,
} from './auth';
import {
  buildServerEnv,
  isUltrafastRegistered,
  reregisterUltrafastBrowser,
  unregisterUltrafastBrowser,
} from './registration';
import {
  ULTRAFAST_IPC,
  type UltrafastStatus,
  type UltrafastTestResult,
} from './ipcTypes';
import {
  callBrowserTask,
  lastScreenshotDataUrl,
  parseSummaryLine,
  summaryText,
} from './mcpClient';
import {
  findUv,
  isProvisioned,
  provisionPythonEnv,
  resolveUltrafastPaths,
  runCommand,
} from './pythonEnv';
import { resolveUltrafastScriptPaths } from './scriptPaths';
import { startTestPage } from './testPage';

// Ultrafast browser tasks — the settings page's IPC surface
// (docs/design/ultrafast-browser-tasks.md). Structured exactly like
// copilotAuth.ts's registerCopilotAuthIpc: one function, called once at
// boot (main.ts), that owns a handful of `ipcMain.handle` calls and the
// small bit of state a probe/test flow needs (here, the last test's
// result, so re-opening Settings shows it without re-running anything).

const provisionLogger = {
  warn: (message: string, meta?: Record<string, unknown>) => {
    // eslint-disable-next-line no-console
    console.warn(`[ultrafast] ${message}`, meta ?? '');
  },
};

let lastTest: UltrafastTestResult | null = null;

function currentPaths() {
  return resolveUltrafastPaths(app.getPath('userData'));
}

function currentScripts() {
  // `process.resourcesPath` is Electron-only — undefined under plain Node,
  // the same fallback engineIpc.ts's own registration call uses.
  return resolveUltrafastScriptPaths(
    app.getAppPath(),
    process.resourcesPath ?? app.getAppPath(),
  );
}

async function runSelfTest(): Promise<
  { ok: true } | { ok: false; message: string }
> {
  const paths = currentPaths();
  const scripts = currentScripts();
  const result = await runCommand(paths.venvPython, [
    scripts.runnerPath,
    '--selftest',
  ]);
  if (result.code !== 0) {
    return {
      ok: false,
      message: `The Python environment failed its self-test: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`}`,
    };
  }
  return { ok: true };
}

/** The full ultrafast:test flow: provision if needed, self-test the venv,
 *  then drive a tiny local page through the real MCP server — the same
 *  server a session's own browser_task call would use. */
async function runUltrafastTest(): Promise<UltrafastTestResult> {
  const testedAt = new Date().toISOString();
  const fail = (message: string): UltrafastTestResult => ({
    ok: false,
    status: null,
    steps: null,
    elapsedMs: null,
    message,
    screenshotDataUrl: null,
    testedAt,
  });

  const key = resolveTypesafeApiKey()?.key ?? null;
  if (!key)
    return fail(
      'Save a TypeSafe API key first, or put TYPESAFE_API_KEY in .env.',
    );

  const uvPath = findUv();
  if (!uvPath) {
    return fail(
      "uv isn't available on this machine — install it from https://docs.astral.sh/uv/.",
    );
  }

  const paths = currentPaths();
  if (!isProvisioned(paths)) {
    const provision = await provisionPythonEnv({
      paths,
      uvPath,
      run: runCommand,
      logger: provisionLogger,
    });
    if (!provision.ok) return fail(provision.message);
  }

  const scripts = currentScripts();
  if (
    !fs.existsSync(scripts.mcpServerEntry) ||
    !fs.existsSync(scripts.runnerPath)
  ) {
    return fail("Ultrafast's scripts are missing from this install.");
  }

  const selftest = await runSelfTest();
  if (!selftest.ok) return fail(selftest.message);

  const page = await startTestPage();
  try {
    fs.mkdirSync(paths.evidenceRoot, { recursive: true });
    const started = Date.now();
    const result = await callBrowserTask({
      entry: scripts.mcpServerEntry,
      execPath: process.execPath,
      // The exact env registration gives the server, so a passing Test
      // means a session's browser_task has what it needs too.
      env: buildServerEnv(key, paths, scripts),
      url: page.url,
      goal: 'Type Ada into the "Your name" field, then press the Continue button.',
      maxSteps: 6,
      timeoutMs: 120_000,
    });
    const elapsedMs = Date.now() - started;
    const { status, steps } = parseSummaryLine(result);
    const record: UltrafastTestResult = {
      ok: !result.isError,
      status,
      steps,
      elapsedMs,
      message: summaryText(result),
      screenshotDataUrl: lastScreenshotDataUrl(result),
      testedAt,
    };
    lastTest = record;
    return record;
  } catch (error) {
    const record = fail(error instanceof Error ? error.message : String(error));
    lastTest = record;
    return record;
  } finally {
    await page.close();
  }
}

export function registerUltrafastIpc(): void {
  ipcMain.handle(ULTRAFAST_IPC.status, (): UltrafastStatus => {
    const resolved = resolveTypesafeApiKey();
    const scripts = currentScripts();
    return {
      uvAvailable: findUv() !== null,
      provisioned: isProvisioned(currentPaths()),
      // F19 (tech-lead review, 2026-09-22): both new facts existed
      // already — scriptsInstalled was computed by ultrafastAvailability()
      // and just never left registration.ts; registered is F15's own
      // isUltrafastRegistered(). Neither was in UltrafastStatus before,
      // so the settings page could not tell "every gate passed" from
      // "the tool is actually live right now".
      scriptsInstalled:
        fs.existsSync(scripts.mcpServerEntry) &&
        fs.existsSync(scripts.runnerPath),
      registered: isUltrafastRegistered(),
      key: {
        configured: resolved !== null,
        tail: resolved ? maskedTail(resolved.key) : null,
        source: resolved?.source ?? null,
      },
      lastTest,
    };
  });

  ipcMain.handle(ULTRAFAST_IPC.saveKey, (_event, rawKey: unknown) => {
    if (typeof rawKey !== 'string' || !rawKey.trim()) {
      return { ok: false, message: 'Paste a key first.' };
    }
    if (!isUltrafastSecureStorageAvailable()) {
      return {
        ok: false,
        message:
          "Secure storage isn't available on this device, so the key can't be saved safely here.",
      };
    }
    const key = rawKey.trim();
    try {
      writeStoredTypesafeApiKey(key);
    } catch {
      return {
        ok: false,
        message:
          "The key couldn't be saved securely on this device — try again.",
      };
    }
    // F15 (tech-lead review, 2026-09-22): a key save used to only write
    // the key and stop — registration only ever ran on the daemon's own
    // per-connection cadence, so a key pasted after the daemon was
    // already connected (the common first-run order: paste key → Test →
    // dispatch a Fix on the same connection) would not reach
    // browser_task's actual registration until the NEXT reconnect, even
    // though `ultrafast:test` above already runs a real task successfully
    // against the key directly (it builds its own env, bypassing
    // registration entirely). Forcing a fresh attempt here closes that
    // window: the tool is live on the very connection the key was saved
    // on, not just the one after.
    reregisterUltrafastBrowser();
    return { ok: true, tail: maskedTail(key) };
  });

  ipcMain.handle(ULTRAFAST_IPC.clearKey, () => {
    deleteStoredTypesafeApiKey();
    // F15: reflect the clear immediately rather than leaving
    // isUltrafastRegistered() (and so ultrafastAvailable() in
    // engineIpc.ts) reporting a now-stale "yes" until the daemon happens
    // to reconnect — see unregisterUltrafastBrowser's own comment for
    // why this can only flip the local flag, not un-register the daemon
    // entry itself.
    unregisterUltrafastBrowser();
    lastTest = null;
    return { ok: true };
  });

  ipcMain.handle(ULTRAFAST_IPC.test, () => runUltrafastTest());
}

/** Test-only: clears the module-level `lastTest` cache between test runs. */
export function resetUltrafastIpcStateForTests(): void {
  lastTest = null;
}
