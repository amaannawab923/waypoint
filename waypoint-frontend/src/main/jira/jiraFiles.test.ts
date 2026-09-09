const showSaveDialogMock = jest.fn();
const showOpenDialogMock = jest.fn();
const showItemInFolderMock = jest.fn();
const getPathMock = jest.fn<string, [string]>(() => '/Users/max/Downloads');
jest.mock('electron', () => ({
  app: { getPath: (name: string) => getPathMock(name) },
  dialog: {
    showSaveDialog: (...args: unknown[]) => showSaveDialogMock(...args),
    showOpenDialog: (...args: unknown[]) => showOpenDialogMock(...args),
  },
  shell: { showItemInFolder: (p: string) => showItemInFolderMock(p) },
}));

const writeFileMock = jest.fn();
const statMock = jest.fn();
const readFileMock = jest.fn();
jest.mock('fs', () => ({
  promises: {
    writeFile: (...args: unknown[]) => writeFileMock(...args),
    stat: (...args: unknown[]) => statMock(...args),
    readFile: (...args: unknown[]) => readFileMock(...args),
  },
}));

const downloadAttachmentMock = jest.fn();
const uploadAttachmentMock = jest.fn();
// The cap is a real exported constant, not a number this file invents — a
// mocked-away `undefined` here would silently disable the guard the size
// tests below exist to prove.
const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;
jest.mock('./jiraClient', () => ({
  MAX_TRANSFER_BYTES: 100 * 1024 * 1024,
  downloadAttachment: (...args: unknown[]) => downloadAttachmentMock(...args),
  uploadAttachment: (...args: unknown[]) => uploadAttachmentMock(...args),
}));

// eslint-disable-next-line import/order, import/first
import {
  downloadAttachmentToDisk,
  mimeTypeForFileName,
  pickAndUploadAttachment,
  safeBaseName,
} from './jiraFiles';

const BYTES = Buffer.from('replay log, line one\n');

/** A window object is only ever passed through to a dialog, so a bare token
 * is enough to prove it was — nothing here calls a method on it. */
const WINDOW = { id: 1 } as never;

const TICKET = { id: '10421', key: 'ENG-421' };

beforeEach(() => {
  jest.clearAllMocks();
  getPathMock.mockReturnValue('/Users/max/Downloads');
  downloadAttachmentMock.mockResolvedValue({
    ok: true,
    value: { bytes: BYTES },
  });
  uploadAttachmentMock.mockResolvedValue({ ok: true, value: TICKET });
  showSaveDialogMock.mockResolvedValue({
    canceled: false,
    filePath: '/Users/max/Downloads/replay-log.txt',
  });
  showOpenDialogMock.mockResolvedValue({
    canceled: false,
    filePaths: ['/Users/max/Desktop/replay-log.txt'],
  });
  writeFileMock.mockResolvedValue(undefined);
  statMock.mockResolvedValue({ size: BYTES.byteLength });
  readFileMock.mockResolvedValue(BYTES);
});

/**
 * Jira attachment filenames are chosen by whoever uploaded the file — anyone
 * with permission to attach to any issue the connected account can see. So
 * `../../../.ssh/authorized_keys` is a name a real attachment can genuinely
 * have, and it arrives here verbatim.
 */
/** A realistic Node fs error: an errno `code` and, crucially, the absolute
 *  path embedded in `message` the way Node actually embeds it. The path is
 *  what these tests exist to keep out of the renderer. */
function fsError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('safeBaseName', () => {
  // A Jira attachment filename is chosen by anyone who can attach to an issue
  // this account can see, and the save dialog is the authorization — so it is
  // only as good as what it displays. Traversal was already defeated; the
  // display was not.
  describe('characters that forge what the dialog shows', () => {
    it('strips a right-to-left override used to disguise an extension', () => {
      // Renders as "invoicexe.png" in a native save sheet: the user confirms
      // an image and an executable lands in Downloads.
      const out = safeBaseName('invoice\u202Egnp.exe');
      expect(out).not.toContain('\u202E');
      expect(out).toBe('invoicegnp.exe');
    });

    it('strips control characters that push the extension out of view', () => {
      expect(safeBaseName('a\r\nb\u0000c.png')).toBe('abc.png');
    });

    it('strips zero-width characters', () => {
      expect(safeBaseName('inv\u200Boice.pdf')).toBe('invoice.pdf');
    });
  });

  it('defuses a Windows reserved device name', () => {
    // Writing to one of these does not create a file, it talks to a device.
    expect(safeBaseName('CON')).toBe('_CON');
    expect(safeBaseName('nul.txt')).toBe('_nul.txt');
    expect(safeBaseName('COM1.log')).toBe('_COM1.log');
    // Only the reserved names themselves — an ordinary name that merely
    // starts with those letters is untouched.
    expect(safeBaseName('console.log')).toBe('console.log');
    expect(safeBaseName('nullable.ts')).toBe('nullable.ts');
  });

  it('caps a very long name while keeping its extension', () => {
    const out = safeBaseName(`${'x'.repeat(400)}.png`);
    expect(out.length).toBeLessThanOrEqual(200);
    // The extension decides what opens the file, so it is the part that has
    // to survive the truncation.
    expect(out.endsWith('.png')).toBe(true);
  });

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
      fsError(
        'ENOSPC',
        "ENOSPC: no space left on device, open '/Users/max/Downloads/replay-log.txt'",
      ),
    );

    const result = await downloadAttachmentToDisk(
      WINDOW,
      '10050',
      'replay-log.txt',
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'file_error',
      message: "Couldn't save that file \u2014 the disk is full",
    });
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  // This file's headline rule is that no filesystem path crosses IPC in
  // either direction. The success path was carefully narrowed to honor it
  // and the failure path was not: Node embeds the absolute path in every fs
  // error message, and that message was returned verbatim as the user-facing
  // JiraFailure, so a save into a private folder disclosed the folder.
  it('never returns the absolute path inside a failure message', async () => {
    writeFileMock.mockRejectedValue(
      fsError(
        'EACCES',
        "EACCES: permission denied, open '/Users/max/clients/acme-acquisition/term-sheet.pdf'",
      ),
    );

    const result = (await downloadAttachmentToDisk(
      WINDOW,
      '10050',
      'term-sheet.pdf',
    )) as { message: string };

    expect(result.message).not.toContain('/Users/max');
    expect(result.message).not.toContain('acme-acquisition');
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

  // The only guard before this one was a `downloading` boolean in
  // JiraTicketDetail.tsx's own React state, and that component mounts
  // twice at once (drawer + full page) with fully independent state — so
  // neither copy can see a download the other kicked off. These tests
  // exercise the module-level guard that both IPC calls now pass through
  // instead, by starting two calls without awaiting the first: an async
  // function runs synchronously up to its first `await`, so the guard is
  // claimed (or found already claimed) before either call has a chance to
  // interleave with the other.
  describe('the single-flight guard', () => {
    it('refuses a second download of the same attachment while the first is in flight', async () => {
      const first = downloadAttachmentToDisk(WINDOW, '10050', 'replay-log.txt');
      const second = downloadAttachmentToDisk(WINDOW, '10050', 'replay-log.txt');

      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toEqual({
        ok: true,
        value: {
          canceled: false,
          savedPath: '/Users/max/Downloads/replay-log.txt',
        },
      });
      expect(secondResult).toMatchObject({
        ok: false,
        reason: 'transfer_in_progress',
      });
      // The refused call never touched Jira, the dialog or the filesystem.
      expect(downloadAttachmentMock).toHaveBeenCalledTimes(1);
      expect(showSaveDialogMock).toHaveBeenCalledTimes(1);
    });

    it('allows a later download of the same attachment once the first has finished', async () => {
      const first = await downloadAttachmentToDisk(
        WINDOW,
        '10050',
        'replay-log.txt',
      );
      expect(first).toMatchObject({ ok: true, value: { canceled: false } });

      const second = await downloadAttachmentToDisk(
        WINDOW,
        '10050',
        'replay-log.txt',
      );
      expect(second).toMatchObject({ ok: true, value: { canceled: false } });
      expect(downloadAttachmentMock).toHaveBeenCalledTimes(2);
    });

    // The guard has to release on every exit path, not just the happy one —
    // otherwise a single failed or cancelled download would permanently
    // block every later download of that same attachment.
    it('releases the guard after a failed download so a later one is not blocked', async () => {
      downloadAttachmentMock.mockResolvedValueOnce({
        ok: false,
        reason: 'forbidden',
        message: "Your Jira account isn't allowed to do that.",
      });

      const failed = await downloadAttachmentToDisk(
        WINDOW,
        '10050',
        'replay-log.txt',
      );
      expect(failed).toMatchObject({ ok: false, reason: 'forbidden' });

      const retried = await downloadAttachmentToDisk(
        WINDOW,
        '10050',
        'replay-log.txt',
      );
      expect(retried).toMatchObject({ ok: true, value: { canceled: false } });
    });

    it('releases the guard after a cancelled save dialog so a later download is not blocked', async () => {
      showSaveDialogMock.mockResolvedValueOnce({ canceled: true, filePath: '' });

      const cancelled = await downloadAttachmentToDisk(
        WINDOW,
        '10050',
        'replay-log.txt',
      );
      expect(cancelled).toEqual({ ok: true, value: { canceled: true } });

      const retried = await downloadAttachmentToDisk(
        WINDOW,
        '10050',
        'replay-log.txt',
      );
      expect(retried).toMatchObject({ ok: true, value: { canceled: false } });
    });

    // Keyed on the attachment id, not one shared "any download" lock — two
    // different attachments must be downloadable at the same time.
    it('allows concurrent downloads of two different attachments', async () => {
      const [a, b] = await Promise.all([
        downloadAttachmentToDisk(WINDOW, '10050', 'replay-log.txt'),
        downloadAttachmentToDisk(WINDOW, '20099', 'other-file.txt'),
      ]);

      expect(a).toMatchObject({ ok: true, value: { canceled: false } });
      expect(b).toMatchObject({ ok: true, value: { canceled: false } });
      expect(downloadAttachmentMock).toHaveBeenCalledTimes(2);
      expect(downloadAttachmentMock).toHaveBeenCalledWith('10050');
      expect(downloadAttachmentMock).toHaveBeenCalledWith('20099');
    });
  });
});

describe('mimeTypeForFileName', () => {
  it.each([
    ['screenshot.PNG', 'image/png'],
    ['report.pdf', 'application/pdf'],
    ['replay.log', 'text/plain'],
    ['bundle.tar.gz', 'application/gzip'],
  ])('names %p as %p', (fileName, expected) => {
    expect(mimeTypeForFileName(fileName)).toBe(expected);
  });

  // Not a degraded fallback — it is the correct name for bytes of unknown
  // kind, and Jira stores and lists the file the same way either way.
  it.each(['thing.qqq', 'Makefile', ''])(
    'answers application/octet-stream for %p',
    (fileName) => {
      expect(mimeTypeForFileName(fileName)).toBe('application/octet-stream');
    },
  );
});

describe('pickAndUploadAttachment', () => {
  // The order is the guard, not a preference: a size cap enforced after the
  // read has already done the thing it exists to prevent, which is pulling an
  // arbitrarily large file into the main process's heap.
  it('stats the file, then reads it, then uploads it', async () => {
    const result = await pickAndUploadAttachment(WINDOW, '10421');

    expect(statMock).toHaveBeenCalledWith('/Users/max/Desktop/replay-log.txt');
    expect(readFileMock).toHaveBeenCalledWith(
      '/Users/max/Desktop/replay-log.txt',
    );
    expect(statMock.mock.invocationCallOrder[0]).toBeLessThan(
      readFileMock.mock.invocationCallOrder[0],
    );
    expect(readFileMock.mock.invocationCallOrder[0]).toBeLessThan(
      uploadAttachmentMock.mock.invocationCallOrder[0],
    );
    expect(uploadAttachmentMock).toHaveBeenCalledWith(
      '10421',
      'replay-log.txt',
      BYTES,
      'text/plain',
    );
    expect(result).toEqual({
      ok: true,
      value: { canceled: false, ticket: TICKET },
    });
  });

  // Single-select is the dialog's own default. `multiSelections` is simply
  // never asked for, rather than a multi-file result being trimmed afterwards.
  it('opens a single-file picker parented to the window', async () => {
    await pickAndUploadAttachment(WINDOW, '10421');

    expect(showOpenDialogMock).toHaveBeenCalledWith(WINDOW, {
      properties: ['openFile'],
    });
    const [, options] = showOpenDialogMock.mock.calls[0];
    expect((options as { properties: string[] }).properties).not.toContain(
      'multiSelections',
    );
  });

  it('opens a free-floating picker when there is no window', async () => {
    await pickAndUploadAttachment(null, '10421');

    expect(showOpenDialogMock).toHaveBeenCalledWith({
      properties: ['openFile'],
    });
  });

  // A cancelled picker is a normal outcome. The renderer's unwrap() throws on
  // any ok:false, so a failure here would fire an error toast on every Escape.
  it('reports a cancelled picker as a success, and reads nothing', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] });

    expect(await pickAndUploadAttachment(WINDOW, '10421')).toEqual({
      ok: true,
      value: { canceled: true },
    });
    expect(statMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
  });

  // Some platforms answer a cancel with `canceled: false` and no paths.
  it('treats an empty selection as a cancel', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [] });

    expect(await pickAndUploadAttachment(WINDOW, '10421')).toEqual({
      ok: true,
      value: { canceled: true },
    });
    expect(readFileMock).not.toHaveBeenCalled();
  });

  // The whole point of stat-before-read: the file is refused without ever
  // being pulled into memory.
  it('refuses an oversized file before reading a byte of it', async () => {
    statMock.mockResolvedValue({ size: MAX_TRANSFER_BYTES + 1 });

    expect(await pickAndUploadAttachment(WINDOW, '10421')).toMatchObject({
      ok: false,
      reason: 'file_error',
      message: expect.stringContaining('100MB'),
    });
    expect(readFileMock).not.toHaveBeenCalled();
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
  });

  // Jira's own limit is usually lower and its own refusal names the site's
  // real number, so the message points there rather than pretending this cap
  // is the one that matters.
  it('points an oversized file at Jira rather than claiming the last word', async () => {
    statMock.mockResolvedValue({ size: MAX_TRANSFER_BYTES + 1 });

    const result = await pickAndUploadAttachment(WINDOW, '10421');

    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('Jira'),
    });
  });

  it('guesses the mime type from the picked file’s own extension', async () => {
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/max/Desktop/screenshot.png'],
    });

    await pickAndUploadAttachment(WINDOW, '10421');

    expect(uploadAttachmentMock).toHaveBeenCalledWith(
      '10421',
      'screenshot.png',
      BYTES,
      'image/png',
    );
  });

  // "Jira said no" and "your disk said no" are different facts about
  // different systems and need different sentences.
  it('reports an unreadable file as file_error, without uploading', async () => {
    readFileMock.mockRejectedValue(
      fsError(
        'EACCES',
        "EACCES: permission denied, open '/Users/max/private/notes.txt'",
      ),
    );

    const result = await pickAndUploadAttachment(WINDOW, '10421');
    expect(result).toMatchObject({ ok: false, reason: 'file_error' });
    expect((result as { message: string }).message).toContain(
      "isn't allowed",
    );
    expect((result as { message: string }).message).not.toContain('/Users/max');
    expect(uploadAttachmentMock).not.toHaveBeenCalled();
  });

  it('reports a file that vanished between the dialog and the stat', async () => {
    statMock.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    expect(await pickAndUploadAttachment(WINDOW, '10421')).toMatchObject({
      ok: false,
      reason: 'file_error',
    });
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it('passes a refusal from Jira straight through', async () => {
    uploadAttachmentMock.mockResolvedValue({
      ok: false,
      reason: 'forbidden',
      message: "Your Jira account isn't allowed to do that.",
    });

    expect(await pickAndUploadAttachment(WINDOW, '10421')).toMatchObject({
      ok: false,
      reason: 'forbidden',
    });
  });

  // Same guard as downloadAttachmentToDisk's, keyed on the ticket id this
  // time rather than the attachment id — see that describe block's own note
  // on why starting two calls without awaiting the first is enough to force
  // the interleaving these tests need.
  describe('the single-flight guard', () => {
    it('refuses a second upload to the same ticket while the first is in flight', async () => {
      const first = pickAndUploadAttachment(WINDOW, '10421');
      const second = pickAndUploadAttachment(WINDOW, '10421');

      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).toEqual({
        ok: true,
        value: { canceled: false, ticket: TICKET },
      });
      expect(secondResult).toMatchObject({
        ok: false,
        reason: 'transfer_in_progress',
      });
      // The refused call never opened a picker, read a file or uploaded.
      expect(showOpenDialogMock).toHaveBeenCalledTimes(1);
      expect(uploadAttachmentMock).toHaveBeenCalledTimes(1);
    });

    it('allows a later upload to the same ticket once the first has finished', async () => {
      const first = await pickAndUploadAttachment(WINDOW, '10421');
      expect(first).toMatchObject({ ok: true, value: { canceled: false } });

      const second = await pickAndUploadAttachment(WINDOW, '10421');
      expect(second).toMatchObject({ ok: true, value: { canceled: false } });
      expect(uploadAttachmentMock).toHaveBeenCalledTimes(2);
    });

    // The guard has to release on every exit path — a failed or cancelled
    // upload must not permanently block every later upload to that ticket.
    it('releases the guard after a failed upload so a later one is not blocked', async () => {
      uploadAttachmentMock.mockResolvedValueOnce({
        ok: false,
        reason: 'forbidden',
        message: "Your Jira account isn't allowed to do that.",
      });

      const failed = await pickAndUploadAttachment(WINDOW, '10421');
      expect(failed).toMatchObject({ ok: false, reason: 'forbidden' });

      const retried = await pickAndUploadAttachment(WINDOW, '10421');
      expect(retried).toMatchObject({ ok: true, value: { canceled: false } });
    });

    it('releases the guard after a cancelled picker so a later upload is not blocked', async () => {
      showOpenDialogMock.mockResolvedValueOnce({
        canceled: true,
        filePaths: [],
      });

      const cancelled = await pickAndUploadAttachment(WINDOW, '10421');
      expect(cancelled).toEqual({ ok: true, value: { canceled: true } });

      const retried = await pickAndUploadAttachment(WINDOW, '10421');
      expect(retried).toMatchObject({ ok: true, value: { canceled: false } });
    });

    // Keyed on the ticket id, not one shared "any upload" lock — two
    // different tickets must both be attachable to at the same time.
    it('allows concurrent uploads to two different tickets', async () => {
      const [a, b] = await Promise.all([
        pickAndUploadAttachment(WINDOW, '10421'),
        pickAndUploadAttachment(WINDOW, '99999'),
      ]);

      expect(a).toMatchObject({ ok: true, value: { canceled: false } });
      expect(b).toMatchObject({ ok: true, value: { canceled: false } });
      expect(uploadAttachmentMock).toHaveBeenCalledTimes(2);
      expect(uploadAttachmentMock).toHaveBeenCalledWith(
        '10421',
        'replay-log.txt',
        BYTES,
        'text/plain',
      );
      expect(uploadAttachmentMock).toHaveBeenCalledWith(
        '99999',
        'replay-log.txt',
        BYTES,
        'text/plain',
      );
    });
  });
});
