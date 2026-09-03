import { showErrorToast } from '@/lib/toast';
import { ApiError, http } from './httpClient';

jest.mock('@/lib/toast', () => ({ showErrorToast: jest.fn() }));

function mockFetchOnce(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

function mockFetchRejects() {
  global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('httpClient', () => {
  it('toasts and throws ApiError with the backend code/path on a failed request', async () => {
    mockFetchOnce(400, {
      error: 'bad path',
      code: 'repo_path_not_found',
      path: '/x',
    });

    await expect(http.get('/projects/p1')).rejects.toMatchObject({
      message: 'bad path',
      code: 'repo_path_not_found',
      path: '/x',
    });
    expect(showErrorToast).toHaveBeenCalledWith('bad path');
  });

  it('suppresses the toast for a silent PATCH failure, but still throws', async () => {
    mockFetchOnce(400, { error: 'bad path', code: 'repo_path_not_git_repo' });

    await expect(
      http.patch('/projects/p1', { repoPath: '/x' }, { silent: true }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  // Regression test: the network-failure branch (fetch() itself throwing,
  // not a non-2xx response) used to call showErrorToast() unconditionally,
  // ignoring `silent` entirely — a caller rendering this failure inline
  // (e.g. a repo link attempted while the server is unreachable) got a
  // toast AND its own inline error for the same failure, exactly the
  // doubled-error problem `silent` exists to prevent.
  it('suppresses the toast on a silent network failure too, not just a silent status-code failure', async () => {
    mockFetchRejects();

    await expect(
      http.patch('/projects/p1', { repoPath: '/x' }, { silent: true }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  it('still toasts a non-silent network failure', async () => {
    mockFetchRejects();

    await expect(http.get('/projects/p1')).rejects.toBeInstanceOf(ApiError);
    expect(showErrorToast).toHaveBeenCalledWith(
      "Couldn't reach the server. Check your connection and try again.",
    );
  });

  it('treats an explicitly-expected 404 as undefined, not a failure, and never touches the toast', async () => {
    mockFetchOnce(404, { error: 'not found' });

    await expect(
      http.get('/projects/missing', { notFoundAsUndefined: true }),
    ).resolves.toBeUndefined();
    expect(showErrorToast).not.toHaveBeenCalled();
  });
});
