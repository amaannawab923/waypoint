import * as fs from 'fs';
import { app, ipcMain } from 'electron';
import {
  deleteStoredTypesafeApiKey,
  isUltrafastSecureStorageAvailable,
  maskedTail,
  readStoredTypesafeApiKey,
  writeStoredTypesafeApiKey,
} from './auth';
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

  const key = readStoredTypesafeApiKey();
  if (!key) return fail('Save a TypeSafe API key first.');

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
      env: {
        ULTRAFAST_TYPESAFE_API_KEY: key,
        ULTRAFAST_VENV_PYTHON: paths.venvPython,
        ULTRAFAST_RUNNER_PATH: scripts.runnerPath,
        ULTRAFAST_BH_HOME: paths.bhHome,
        ULTRAFAST_EVIDENCE_ROOT: paths.evidenceRoot,
      },
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
    const key = readStoredTypesafeApiKey();
    return {
      uvAvailable: findUv() !== null,
      provisioned: isProvisioned(currentPaths()),
      key: { configured: key !== null, tail: key ? maskedTail(key) : null },
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
    return { ok: true, tail: maskedTail(key) };
  });

  ipcMain.handle(ULTRAFAST_IPC.clearKey, () => {
    deleteStoredTypesafeApiKey();
    lastTest = null;
    return { ok: true };
  });

  ipcMain.handle(ULTRAFAST_IPC.test, () => runUltrafastTest());
}

/** Test-only: clears the module-level `lastTest` cache between test runs. */
export function _resetUltrafastIpcStateForTests(): void {
  lastTest = null;
}
