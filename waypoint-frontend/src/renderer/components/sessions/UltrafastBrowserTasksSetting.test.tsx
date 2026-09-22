import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  clearUltrafastKey,
  getUltrafastStatus,
  saveUltrafastKey,
  testUltrafast,
} from '@/data/ultrafastApi';
import { UltrafastBrowserTasksSetting } from './UltrafastBrowserTasksSetting';

jest.mock('@/data/ultrafastApi', () => ({
  getUltrafastStatus: jest.fn(),
  saveUltrafastKey: jest.fn(),
  clearUltrafastKey: jest.fn(),
  testUltrafast: jest.fn(),
}));

const flush = () =>
  act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      }),
  );

beforeEach(() => jest.clearAllMocks());

describe('UltrafastBrowserTasksSetting', () => {
  it('shows uv missing before anything else, even with a key configured', async () => {
    (getUltrafastStatus as jest.Mock).mockResolvedValue({
      uvAvailable: false,
      provisioned: false,
      scriptsInstalled: true,
      registered: false,
      key: { configured: true, tail: '…1234', source: 'settings' },
      lastTest: null,
    });
    render(<UltrafastBrowserTasksSetting />);
    await flush();
    expect(screen.getByText(/uv missing/)).toBeInTheDocument();
  });

  it('shows "Not configured" when uv is fine but no key is saved', async () => {
    (getUltrafastStatus as jest.Mock).mockResolvedValue({
      uvAvailable: true,
      provisioned: false,
      scriptsInstalled: true,
      registered: false,
      key: { configured: false, tail: null, source: null },
      lastTest: null,
    });
    render(<UltrafastBrowserTasksSetting />);
    await flush();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled();
  });

  it('shows "Ready" only once uv, key, scripts, provisioning, AND registration are all true', async () => {
    (getUltrafastStatus as jest.Mock).mockResolvedValue({
      uvAvailable: true,
      provisioned: true,
      scriptsInstalled: true,
      registered: true,
      key: { configured: true, tail: '…1234', source: 'settings' },
      lastTest: null,
    });
    render(<UltrafastBrowserTasksSetting />);
    await flush();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test' })).not.toBeDisabled();
  });

  // F19 (tech-lead review, 2026-09-22): a missing-scripts install (a bad
  // build, extraResources not copied) used to satisfy uv/key/provisioned
  // and show "Ready" anyway — scriptsInstalled never reached the
  // renderer at all.
  it('reports missing scripts honestly instead of claiming Ready', async () => {
    (getUltrafastStatus as jest.Mock).mockResolvedValue({
      uvAvailable: true,
      provisioned: true,
      scriptsInstalled: false,
      registered: false,
      key: { configured: true, tail: '…1234', source: 'settings' },
      lastTest: null,
    });
    render(<UltrafastBrowserTasksSetting />);
    await flush();
    expect(
      screen.getByText(/missing Ultrafast's own scripts/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });

  // F19: every OTHER gate can be true — key saved, uv present, scripts
  // installed, provisioned — while the daemon has not actually registered
  // browser_task yet (the window F15 closes for the common case, but a
  // session could still start in it, e.g. right after a fresh install
  // before the first daemon connection). "Ready" must not claim more than
  // is actually true.
  it('does not claim Ready when every other gate passes but the daemon has not registered it yet', async () => {
    (getUltrafastStatus as jest.Mock).mockResolvedValue({
      uvAvailable: true,
      provisioned: true,
      scriptsInstalled: true,
      registered: false,
      key: { configured: true, tail: '…1234', source: 'settings' },
      lastTest: null,
    });
    render(<UltrafastBrowserTasksSetting />);
    await flush();
    expect(
      screen.getByText('Configured, but not registered with a session yet'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });

  it('saves a pasted key, clears the input, and reloads the status', async () => {
    (getUltrafastStatus as jest.Mock)
      .mockResolvedValueOnce({
        uvAvailable: true,
        provisioned: false,
        scriptsInstalled: true,
        registered: false,
        key: { configured: false, tail: null, source: null },
        lastTest: null,
      })
      .mockResolvedValueOnce({
        uvAvailable: true,
        provisioned: false,
        scriptsInstalled: true,
        registered: false,
        key: { configured: true, tail: '…cdef', source: 'settings' },
        lastTest: null,
      });
    (saveUltrafastKey as jest.Mock).mockResolvedValue({
      ok: true,
      tail: '…cdef',
    });

    render(<UltrafastBrowserTasksSetting />);
    await flush();

    const input = screen.getByLabelText('TypeSafe API key');
    fireEvent.change(input, { target: { value: 'ts_live_abcdef' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flush();

    expect(saveUltrafastKey).toHaveBeenCalledWith('ts_live_abcdef');
    expect(getUltrafastStatus).toHaveBeenCalledTimes(2);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('shows a save failure message without clearing the input', async () => {
    (getUltrafastStatus as jest.Mock).mockResolvedValue({
      uvAvailable: true,
      provisioned: false,
      scriptsInstalled: true,
      registered: false,
      key: { configured: false, tail: null, source: null },
      lastTest: null,
    });
    (saveUltrafastKey as jest.Mock).mockResolvedValue({
      ok: false,
      message: "That doesn't look like a TypeSafe key.",
    });

    render(<UltrafastBrowserTasksSetting />);
    await flush();

    const input = screen.getByLabelText('TypeSafe API key');
    fireEvent.change(input, { target: { value: 'not-a-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await flush();

    expect(
      screen.getByText("That doesn't look like a TypeSafe key."),
    ).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe('not-a-key');
  });

  it('clears the stored key', async () => {
    (getUltrafastStatus as jest.Mock).mockResolvedValue({
      uvAvailable: true,
      provisioned: true,
      scriptsInstalled: true,
      registered: false,
      key: { configured: true, tail: '…1234', source: 'settings' },
      lastTest: null,
    });
    (clearUltrafastKey as jest.Mock).mockResolvedValue({ ok: true });

    render(<UltrafastBrowserTasksSetting />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await flush();
    expect(clearUltrafastKey).toHaveBeenCalled();
  });

  it('runs a test and shows the result and screenshot inline', async () => {
    (getUltrafastStatus as jest.Mock).mockResolvedValue({
      uvAvailable: true,
      provisioned: true,
      scriptsInstalled: true,
      registered: false,
      key: { configured: true, tail: '…1234', source: 'settings' },
      lastTest: null,
    });
    (testUltrafast as jest.Mock).mockResolvedValue({
      ok: true,
      status: 'done',
      steps: 2,
      elapsedMs: 640,
      message: 'status: done · 2 step(s)',
      screenshotDataUrl: 'data:image/jpeg;base64,AAA',
      testedAt: '2026-09-22T00:00:00.000Z',
    });

    render(<UltrafastBrowserTasksSetting />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await flush();

    expect(testUltrafast).toHaveBeenCalled();
    expect(screen.getByText(/2 step\(s\) in 640ms/)).toBeInTheDocument();
    expect(screen.getByAltText('Ultrafast test — final page')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,AAA',
    );
  });

  it('shows a failed test message without a screenshot', async () => {
    (getUltrafastStatus as jest.Mock).mockResolvedValue({
      uvAvailable: true,
      provisioned: true,
      scriptsInstalled: true,
      registered: false,
      key: { configured: true, tail: '…1234', source: 'settings' },
      lastTest: null,
    });
    (testUltrafast as jest.Mock).mockResolvedValue({
      ok: false,
      status: null,
      steps: null,
      elapsedMs: null,
      message: "uv isn't available on this machine.",
      screenshotDataUrl: null,
      testedAt: '2026-09-22T00:00:00.000Z',
    });

    render(<UltrafastBrowserTasksSetting />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await flush();

    expect(
      screen.getAllByText(/uv isn't available on this machine\./).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByAltText('Ultrafast test — final page'),
    ).not.toBeInTheDocument();
  });
});

// Founder (2026-09-22): a key pasted into waypoint-frontend/.env also works.
// The section says so, shows the tail, and offers no Clear — there is
// nothing stored to clear; the file is the person's own.
describe('a key from .env', () => {
  it('says where the key comes from and offers no Clear', async () => {
    (getUltrafastStatus as jest.Mock).mockResolvedValue({
      uvAvailable: true,
      provisioned: true,
      scriptsInstalled: true,
      registered: false,
      key: { configured: true, tail: '…9f0e', source: 'env' },
      lastTest: null,
    });
    render(<UltrafastBrowserTasksSetting />);
    expect(await screen.findByText(/Using/)).toHaveTextContent(
      'Using TYPESAFE_API_KEY from .env (…9f0e)',
    );
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Test' })).toBeEnabled();
  });
});
