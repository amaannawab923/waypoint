import { removeStaleStartLock } from './staleLock';

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}
function esrch(): NodeJS.ErrnoException {
  return Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
}

describe('removeStaleStartLock', () => {
  it('leaves a lock alone when the pid it names is alive', async () => {
    const rm = jest.fn(async () => {});
    const outcome = await removeStaleStartLock('/run/workspace.sock.lock', {
      readFile: async () => '4242\n',
      probePid: () => {},
      rm,
    });
    expect(outcome).toEqual({ kind: 'kept', pid: 4242 });
    expect(rm).not.toHaveBeenCalled();
  });

  it('treats EPERM from the probe as alive — the process exists, it is just not ours', async () => {
    const rm = jest.fn(async () => {});
    const outcome = await removeStaleStartLock('/l', {
      readFile: async () => '7',
      probePid: () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      },
      rm,
    });
    expect(outcome).toEqual({ kind: 'kept', pid: 7 });
    expect(rm).not.toHaveBeenCalled();
  });

  it('removes a lock whose pid is gone', async () => {
    const rm = jest.fn(async () => {});
    const outcome = await removeStaleStartLock('/l', {
      readFile: async () => '99999\n',
      probePid: () => {
        throw esrch();
      },
      rm,
    });
    expect(outcome).toEqual({ kind: 'removed', reason: 'dead-pid' });
    expect(rm).toHaveBeenCalledWith('/l');
  });

  it('removes a lock it cannot read a pid from', async () => {
    const rm = jest.fn(async () => {});
    for (const content of ['', 'garbage', '-3', '0']) {
      rm.mockClear();
      const outcome = await removeStaleStartLock('/l', {
        readFile: async () => content,
        probePid: () => {},
        rm,
      });
      expect(outcome).toEqual({ kind: 'removed', reason: 'unreadable' });
      expect(rm).toHaveBeenCalledWith('/l');
    }
  });

  it('is a no-op when there is no lock', async () => {
    const rm = jest.fn(async () => {});
    const outcome = await removeStaleStartLock('/l', {
      readFile: async () => {
        throw enoent();
      },
      probePid: () => {},
      rm,
    });
    expect(outcome).toEqual({ kind: 'absent' });
    expect(rm).not.toHaveBeenCalled();
  });
});
