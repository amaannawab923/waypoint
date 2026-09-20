import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, ipcMain } from 'electron';

// "Use my Chrome" for Copilot (POC, 2026-09-20). Copilot can drive the
// user's OWN, logged-in Chrome through Anthropic's Claude in Chrome
// extension — the one browser route evaluated that needs no debug port, no
// per-profile toggle, and no dialog per attach: the extension is installed
// once from the Web Store, and Chrome itself launches the bridge it talks to
// (a native-messaging host) whenever a Claude session asks for it.
//
// Waypoint's side is deliberately small. The SDK turns the bridge on with a
// single CLI flag (`--chrome`, passed via `extraArgs` — see
// claudeSession.ts's buildSdkOptions), so everything here is about the two
// preconditions that flag silently depends on:
//
//  1. The user has opted in. Their logged-in browser is their identity; a
//     Copilot turn must never reach for it because a setting defaulted on.
//     Off by default, stored as a plain JSON preference in userData (no
//     secret in it — safeStorage would be theatre).
//  2. The bridge exists on this machine. `claude --chrome` (the CLI, run at
//     least once) writes a native-messaging host manifest into Chrome's
//     profile-independent NativeMessagingHosts directory, pointing at a
//     wrapper script that execs `claude --chrome-native-host`. Without that
//     manifest the flag connects nothing and the model is left claiming a
//     browser it doesn't have — so the preference is only honoured when the
//     manifest is present AND its `path` still exists, re-checked on every
//     turn rather than once at settings time (a CLI uninstall between turns
//     degrades to "no browser", not a broken conversation).
//
// Sessions (the worktree runs) do NOT get this: they run through the emdash
// daemon's ACP adapter, which has no way to pass the flag, and a logged-in
// browser is a foreground, one-at-a-time, watch-it-work resource — the
// Copilot conversation is that surface; N parallel runs are not.

const PREFERENCE_FILE_NAME = 'copilot-browser.json';

// The host name is Anthropic's, fixed by the extension's own allowed_origins
// — Waypoint reads the file, never writes it.
export const NATIVE_HOST_MANIFEST_NAME =
  'com.anthropic.claude_code_browser_extension.json';

export type BrowserBridgeState =
  /** Manifest present, host script present: `--chrome` will connect. */
  | 'ready'
  /** No manifest (or its host script is gone): run `claude --chrome` once. */
  | 'host-missing'
  /** Windows registers native hosts in the registry — not probed here (POC). */
  | 'unsupported-platform';

export interface BrowserBridgeProbe {
  state: BrowserBridgeState;
  /** Where the manifest was looked for, for the settings page to show. */
  manifestPath: string | null;
}

export interface BrowserAccessStatus extends BrowserBridgeProbe {
  /** The stored preference — what the user chose, regardless of `state`. */
  enabled: boolean;
}

// Chrome's own NativeMessagingHosts location per platform (Chrome's native
// messaging docs) — user-level, not the profile directory, which is why one
// manifest serves every profile. Chrome only for the POC: Chromium/Brave/Edge
// keep their own directories and their own copies of the extension.
export function nativeHostManifestPath(
  platform: typeof process.platform = process.platform,
  home: string = os.homedir(),
): string | null {
  switch (platform) {
    case 'darwin':
      return path.join(
        home,
        'Library',
        'Application Support',
        'Google',
        'Chrome',
        'NativeMessagingHosts',
        NATIVE_HOST_MANIFEST_NAME,
      );
    case 'linux':
      return path.join(
        home,
        '.config',
        'google-chrome',
        'NativeMessagingHosts',
        NATIVE_HOST_MANIFEST_NAME,
      );
    default:
      return null;
  }
}

export function probeBrowserBridge(
  manifestPath: string | null = nativeHostManifestPath(),
): BrowserBridgeProbe {
  if (!manifestPath) return { state: 'unsupported-platform', manifestPath };
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const hostPath =
      parsed && typeof parsed === 'object' && 'path' in parsed
        ? (parsed as { path?: unknown }).path
        : undefined;
    // The manifest outliving its host (a CLI uninstall leaves Chrome's copy
    // behind) is the realistic stale case: Chrome would fail to launch the
    // host and the flag would connect nothing.
    if (typeof hostPath === 'string' && fs.existsSync(hostPath)) {
      return { state: 'ready', manifestPath };
    }
  } catch {
    // Missing or unreadable manifest — the normal "never ran claude --chrome"
    // state, not an error.
  }
  return { state: 'host-missing', manifestPath };
}

function preferencePath(): string {
  return path.join(app.getPath('userData'), PREFERENCE_FILE_NAME);
}

export function readBrowserAccessEnabled(): boolean {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(preferencePath(), 'utf8'),
    );
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      (parsed as { useMyChrome?: unknown }).useMyChrome === true
    );
  } catch {
    return false;
  }
}

export function writeBrowserAccessEnabled(enabled: boolean): void {
  fs.writeFileSync(preferencePath(), JSON.stringify({ useMyChrome: enabled }), {
    mode: 0o600,
  });
}

export function browserAccessStatus(): BrowserAccessStatus {
  return { enabled: readBrowserAccessEnabled(), ...probeBrowserBridge() };
}

/**
 * The per-turn answer copilotRunner.ts asks: opted in AND the bridge is
 * actually there right now. Both re-read every turn — a preference flipped
 * in Settings or a CLI (un)installed mid-conversation takes effect on the
 * very next message, the same way the Jira credential does.
 */
export function browserAccessGrantedForTurn(): boolean {
  return readBrowserAccessEnabled() && probeBrowserBridge().state === 'ready';
}

export function registerCopilotBrowserIpc(): void {
  ipcMain.handle('copilot:browser:status', () => browserAccessStatus());
  ipcMain.handle('copilot:browser:set-enabled', (_event, raw: unknown) => {
    // Anything but a literal true is off — a malformed payload must never
    // widen what Copilot can reach.
    writeBrowserAccessEnabled(raw === true);
    return browserAccessStatus();
  });
}
