const showSaveDialogMock = jest.fn();
const showItemInFolderMock = jest.fn();
const getPathMock = jest.fn<string, [string]>(() => '/Users/max/Downloads');
jest.mock('electron', () => ({
  app: { getPath: (name: string) => getPathMock(name) },
  dialog: {
    showSaveDialog: (...args: unknown[]) => showSaveDialogMock(...args),
  },
  shell: { showItemInFolder: (p: string) => showItemInFolderMock(p) },
}));

const writeFileMock = jest.fn();
jest.mock('fs', () => ({
  promises: { writeFile: (...args: unknown[]) => writeFileMock(...args) },
}));

const downloadAttachmentMock = jest.fn();
jest.mock('./jiraClient', () => ({
  downloadAttachment: (...args: unknown[]) => downloadAttachmentMock(...args),
}));

// eslint-disable-next-line import/order, import/first
import { downloadAttachmentToDisk, safeBaseName } from './jiraFiles';

const BYTES = Buffer.from('replay log, line one\n');

/** A window object is only ever passed through to a dialog, so a bare token
 * is enough to prove it was — nothing here calls a method on it. */
const WINDOW = { id: 1 } as never;

beforeEach(() => {
  jest.clearAllMocks();
  getPathMock.mockReturnValue('/Users/max/Downloads');
  downloadAttachmentMock.mockResolvedValue({
    ok: true,
    value: { bytes: BYTES },
  });
  showSaveDialogMock.mockResolvedValue({
    canceled: false,
    filePath: '/Users/max/Downloads/replay-log.txt',
  });
  writeFileMock.mockResolvedValue(undefined);
});

/**
 * Jira attachment filenames are chosen by whoever uploaded the file — anyone
 * with permission to attach to any issue the connected account can see. So
 * `../../../.ssh/authorized_keys` is a name a real attachment can genuinely
 * have, and it arrives here verbatim.
 */
describe('safeBaseName', () => {
  it('keeps an ordinary filename intact', () => {
    expect(safeBaseName('replay-log.txt')).toBe('replay-log.txt');
    expect(safeBaseName('Q3 report (final).pdf')).toBe('Q3 report (final).pdf');
  });

  it('strips a POSIX path traversal down to its last component', () => {
    expect(safeBaseName('../../etc/passwd')).toBe('passwd');
    expect(safeBaseName('/etc/shadow')).toBe('shadow');
    expect(safeBaseName('../../../.ssh/authorized_keys')).toBe(
      'authorized_keys',
    );
  });

  // path.basename on POSIX does not treat a backslash as a separator at all,
  // so a Windows-shaped traversal survives it completely intact — which is
  // why backslashes are normalized before basename runs rather than after.
  it('strips a Windows path traversal too, on any platform', () => {
    expect(safeBaseName('..\\..\\windows\\system32')).toBe('system32');
    expect(safeBaseName('C:\\Users\\max\\.ssh\\id_rsa')).toBe('id_rsa');
  });

  it.each([
    ['', 'an empty string'],
    ['   ', 'only whitespace'],
    ['///', 'only separators'],
    ['..', 'the parent directory'],
    ['.', 'the current directory'],
    ['../..', 'nothing but parent directories'],
  ])('falls back to a generic name for %p (%s)', (input) => {
    expect(safeBaseName(input)).toBe('attachment');
  });

  // A NUL truncates a path in libc, so a name containing one can mean two
  // different things depending on who reads it.
  it('removes NUL bytes rather than leaving an ambiguous name', () => {
    const name = safeBaseName(`notes.txt${String.fromCharCode(0)}.sh`);
    expect(name).toBe('notes.txt.sh');
    expect(name).not.toContain(String.fromCharCode(0));
  });

  it('replaces characters that are separators or reserved elsewhere', () => {
    expect(safeBaseName('a:b*c?d"e<f>g|h.txt')).toBe('a_b_c_d_e_f_g_h.txt');
  });

  it.each([
    '../../etc/passwd',
    '..\\..\\windows\\system32',
    '/tmp/x/y',
    'a/b\\c',
  ])('never leaves a path separator in the result for %p', (hostile) => {
    const safe = safeBaseName(hostile);
    expect(safe).not.toContain('/');
    expect(safe).not.toContain('\\');
  });
});

describe('downloadAttachmentToDisk', () => {
  // The order is the design: fetch first so a download Jira is going to
  // refuse fails before the user is made to pick a filename for nothing, and
  // write only after the dialog resolves so nothing lands anywhere the user
  // did not choose.
  it('fetches the bytes, then asks where to put them, then writes once', async () => {
    const result = await downloadAttachmentToDisk(
      WINDOW,
      '10050',
      'replay-log.txt',
    );

    expect(downloadAttachmentMock).toHaveBeenCalledWith('10050');
    expect(downloadAttachmentMock.mock.invocationCallOrder[0]).toBeLessThan(
      showSaveDialogMock.mock.invocationCallOrder[0],
    );
    expect(showSaveDialogMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeFileMock.mock.invocationCallOrder[0],
    );
    expect(writeFileMock).toHaveBeenCalledWith(
      '/Users/max/Downloads/replay-log.txt',
      BYTES,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        canceled: false,
        savedPath: '/Users/max/Downloads/replay-log.txt',
      },
    });
  });

  it('parents the dialog to the window and defaults into Downloads', async () => {
    await downloadAttachmentToDisk(WINDOW, '10050', 'replay-log.txt');

    expect(showSaveDialogMock).toHaveBeenCalledWith(WINDOW, {
      defaultPath: '/Users/max/Downloads/replay-log.txt',
    });
  });

  // There genuinely may be no window — a free-floating dialog is the right
  // answer there rather than an error, the same call repoLink.ts makes.
  it('opens a free-floating dialog when there is no window', async () => {
    await downloadAttachmentToDisk(null, '10050', 'replay-log.txt');

    expect(showSaveDialogMock).toHaveBeenCalledWith({
      defaultPath: '/Users/max/Downloads/replay-log.txt',
    });
  });

  // The name is attacker-influenced and it seeds a dialog default. A default
  // nobody reads closely is exactly the thing not to aim at someone's home
  // directory.
  it('sanitizes a hostile filename before it reaches the dialog', async () => {
    await downloadAttachmentToDisk(
      WINDOW,
      '10050',
      '../../../.ssh/authorized_keys',
    );

    expect(showSaveDialogMock).toHaveBeenCalledWith(WINDOW, {
      defaultPath: '/Users/max/Downloads/authorized_keys',
    });
  });

  // `unwrap` in data/jiraApi.ts throws on any ok:false and every caller turns
  // that into an error toast — so a cancel modelled as a failure would pop a
  // red message every time somebody pressed Escape.
  it('reports a cancel as a success, and writes nothing', async () => {
    showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: '' });

    expect(
      await downloadAttachmentToDisk(WINDOW, '10050', 'replay-log.txt'),
    ).toEqual({ ok: true, value: { canceled: true } });
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  // This app's toasts have no success channel, so revealing the file is the
  // confirmation that it was saved.
  it('reveals the saved file in the OS file manager', async () => {
    await downloadAttachmentToDisk(WINDOW, '10050', 'replay-log.txt');

    expect(showItemInFolderMock).toHaveBeenCalledWith(
      '/Users/max/Downloads/replay-log.txt',
    );
  });

  it('never opens a dialog when Jira refused the download', async () => {
    downloadAttachmentMock.mockResolvedValue({
      ok: false,
      reason: 'forbidden',
      message: "Your Jira account isn't allowed to do that.",
    });

    expect(
      await downloadAttachmentToDisk(WINDOW, '10050', 'replay-log.txt'),
    ).toMatchObject({ ok: false, reason: 'forbidden' });
    expect(showSaveDialogMock).not.toHaveBeenCalled();
  });

  // "Jira said no" and "your disk said no" are different facts about
  // different systems, and sending someone to their Jira admin over a full
  // disk wastes their time on someone else's problem.
  it('reports a failed write as file_error, distinctly from a Jira error', async () => {
    writeFileMock.mockRejectedValue(
      new Error('ENOSPC: no space left on device'),
    );

    const result = await downloadAttachmentToDisk(
      WINDOW,
      '10050',
      'replay-log.txt',
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'file_error',
      message: expect.stringContaining('ENOSPC'),
    });
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  // Documented to throw when the OS has no such directory. An undefined
  // suggestion is a fine outcome; an unhandled rejection is not.
  it('still offers a dialog when the OS has no downloads folder', async () => {
    getPathMock.mockImplementation(() => {
      throw new Error('Failed to get downloads path');
    });

    expect(
      await downloadAttachmentToDisk(WINDOW, '10050', 'replay-log.txt'),
    ).toMatchObject({ ok: true });
    expect(showSaveDialogMock).toHaveBeenCalledWith(WINDOW, {
      defaultPath: 'replay-log.txt',
    });
  });
});
