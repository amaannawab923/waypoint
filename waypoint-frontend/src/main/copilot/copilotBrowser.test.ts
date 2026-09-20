import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ipcMainHandleMock = jest.fn();
let userDataDir = '';
jest.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  ipcMain: { handle: (...args: unknown[]) => ipcMainHandleMock(...args) },
}));

// Same hazard as copilotRunner.test.ts: the import must follow the mocks.
// eslint-disable-next-line import/order, import/first
import {
  NATIVE_HOST_MANIFEST_NAME,
  browserAccessGrantedForTurn,
  browserAccessStatus,
  nativeHostManifestPath,
  probeBrowserBridge,
  readBrowserAccessEnabled,
  registerCopilotBrowserIpc,
  writeBrowserAccessEnabled,
} from './copilotBrowser';

let scratch = '';
beforeEach(() => {
  jest.clearAllMocks();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'waypoint-copilot-browser-'));
  userDataDir = path.join(scratch, 'userData');
  fs.mkdirSync(userDataDir);
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

// A manifest shaped like the one `claude --chrome` really writes, pointing
// at a host script that exists (or, per test, doesn't).
function writeManifest(hostPath: string): string {
  const manifestPath = path.join(scratch, NATIVE_HOST_MANIFEST_NAME);
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      name: 'com.anthropic.claude_code_browser_extension',
      path: hostPath,
      type: 'stdio',
      allowed_origins: ['chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/'],
    }),
  );
  return manifestPath;
}

describe('nativeHostManifestPath', () => {
  it("is Chrome's user-level NativeMessagingHosts directory on macOS and Linux", () => {
    expect(nativeHostManifestPath('darwin', '/Users/u')).toBe(
      `/Users/u/Library/Application Support/Google/Chrome/NativeMessagingHosts/${NATIVE_HOST_MANIFEST_NAME}`,
    );
    expect(nativeHostManifestPath('linux', '/home/u')).toBe(
      `/home/u/.config/google-chrome/NativeMessagingHosts/${NATIVE_HOST_MANIFEST_NAME}`,
    );
  });

  it('is null on Windows (registry-based; not probed in the POC)', () => {
    expect(nativeHostManifestPath('win32', 'C:\\Users\\u')).toBeNull();
  });
});

describe('probeBrowserBridge', () => {
  it('is ready when the manifest exists and its host script exists', () => {
    const host = path.join(scratch, 'chrome-native-host');
    fs.writeFileSync(host, '#!/bin/sh\nexec claude --chrome-native-host\n');
    const manifestPath = writeManifest(host);
    expect(probeBrowserBridge(manifestPath)).toEqual({
      state: 'ready',
      manifestPath,
    });
  });

  it('is host-missing when there is no manifest at all', () => {
    const manifestPath = path.join(scratch, NATIVE_HOST_MANIFEST_NAME);
    expect(probeBrowserBridge(manifestPath)).toEqual({
      state: 'host-missing',
      manifestPath,
    });
  });

  // The realistic stale case: a CLI uninstall leaves Chrome's copy of the
  // manifest behind, and the flag would then connect nothing.
  it('is host-missing when the manifest names a host script that is gone', () => {
    const manifestPath = writeManifest(path.join(scratch, 'not-there'));
    expect(probeBrowserBridge(manifestPath).state).toBe('host-missing');
  });

  it('is host-missing on a malformed manifest rather than throwing', () => {
    const manifestPath = path.join(scratch, NATIVE_HOST_MANIFEST_NAME);
    fs.writeFileSync(manifestPath, '{not json');
    expect(probeBrowserBridge(manifestPath).state).toBe('host-missing');
  });

  it('is unsupported-platform when there is nowhere to look', () => {
    expect(probeBrowserBridge(null)).toEqual({
      state: 'unsupported-platform',
      manifestPath: null,
    });
  });
});

describe('the stored preference', () => {
  it('is off when nothing was ever saved', () => {
    expect(readBrowserAccessEnabled()).toBe(false);
  });

  it('round-trips, and only a literal true counts as on', () => {
    writeBrowserAccessEnabled(true);
    expect(readBrowserAccessEnabled()).toBe(true);
    writeBrowserAccessEnabled(false);
    expect(readBrowserAccessEnabled()).toBe(false);
    fs.writeFileSync(
      path.join(userDataDir, 'copilot-browser.json'),
      JSON.stringify({ useMyChrome: 'true' }),
    );
    expect(readBrowserAccessEnabled()).toBe(false);
  });

  it('is off on a corrupt file rather than throwing', () => {
    fs.writeFileSync(path.join(userDataDir, 'copilot-browser.json'), '???');
    expect(readBrowserAccessEnabled()).toBe(false);
  });
});

describe('browserAccessGrantedForTurn', () => {
  // The probe runs against this machine's real Chrome directory here, so
  // this test can only pin the half that is machine-independent: the
  // preference being off must win regardless of what the probe says.
  it('is false while the preference is off, whatever the bridge state', () => {
    expect(browserAccessGrantedForTurn()).toBe(false);
  });

  it('reports the preference and the probe side by side', () => {
    writeBrowserAccessEnabled(true);
    const status = browserAccessStatus();
    expect(status.enabled).toBe(true);
    expect(['ready', 'host-missing', 'unsupported-platform']).toContain(
      status.state,
    );
  });
});

describe('registerCopilotBrowserIpc', () => {
  function handler(channel: string): (...args: unknown[]) => unknown {
    const call = ipcMainHandleMock.mock.calls.find((c) => c[0] === channel);
    if (!call) throw new Error(`no handler registered for ${channel}`);
    return call[1] as (...args: unknown[]) => unknown;
  }

  it('set-enabled stores only a literal true, and answers with the new status', () => {
    registerCopilotBrowserIpc();
    const set = handler('copilot:browser:set-enabled');
    expect((set({}, true) as { enabled: boolean }).enabled).toBe(true);
    expect(readBrowserAccessEnabled()).toBe(true);
    // A malformed payload must never widen what Copilot can reach.
    expect((set({}, 'yes') as { enabled: boolean }).enabled).toBe(false);
    expect(readBrowserAccessEnabled()).toBe(false);
    expect(
      (handler('copilot:browser:status')({}) as { enabled: boolean }).enabled,
    ).toBe(false);
  });
});
