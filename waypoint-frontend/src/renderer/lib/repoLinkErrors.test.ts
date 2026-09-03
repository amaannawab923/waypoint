import { ApiError } from '@/mock/httpClient';
import { describeRepoLinkError } from './repoLinkErrors';

describe('describeRepoLinkError', () => {
  it('maps the not-a-git-repo code to actionable copy naming the picked path', () => {
    const copy = describeRepoLinkError(
      new ApiError(
        'repoPath is not a git repository: /Users/amaan/code/waypoint/src',
        'repo_path_not_git_repo',
        '/Users/amaan/code/waypoint/src',
      ),
    );

    expect(copy.title).toBe("That folder isn't a git repository");
    expect(copy.body).toContain('/Users/amaan/code/waypoint/src');
    expect(copy.body).toContain('.git');
  });

  it('maps the missing-folder code', () => {
    const copy = describeRepoLinkError(
      new ApiError(
        'repoPath does not exist: /Users/amaan/gone',
        'repo_path_not_found',
        '/Users/amaan/gone',
      ),
    );

    expect(copy.title).toBe("That folder doesn't exist");
    expect(copy.body).toContain('/Users/amaan/gone');
  });

  it('maps the not-a-directory code', () => {
    const copy = describeRepoLinkError(
      new ApiError(
        'repoPath is not a directory: /Users/amaan/notes.txt',
        'repo_path_not_directory',
        '/Users/amaan/notes.txt',
      ),
    );

    expect(copy.title).toBe("That's a file, not a folder");
    expect(copy.body).toContain('/Users/amaan/notes.txt');
  });

  // The raw backend message stays the source of truth — it just stops
  // leading. Every branch keeps it available for the Technical details
  // disclosure.
  it('always keeps the raw backend message available', () => {
    const raw = 'repoPath is not a git repository: /x';
    expect(
      describeRepoLinkError(new ApiError(raw, 'repo_path_not_git_repo', '/x')).raw,
    ).toBe(raw);
    expect(describeRepoLinkError(new Error(raw)).raw).toBe(raw);
  });

  it('falls back to the raw message under a generic title when there is no code', () => {
    const copy = describeRepoLinkError(new Error('Network error: /projects/p1'));

    expect(copy.title).toBe('Something went wrong');
    expect(copy.body).toBe('Network error: /projects/p1');
  });

  // A code this frontend has no copy for must not render blank — an older
  // build meeting a newer backend is a real case.
  it('falls back for an ApiError carrying an unknown code', () => {
    const copy = describeRepoLinkError(
      new ApiError('something new went wrong', 'repo_path_on_fire', '/x'),
    );

    expect(copy.title).toBe('Something went wrong');
    expect(copy.body).toBe('something new went wrong');
  });

  it('handles a non-Error rejection without throwing', () => {
    expect(describeRepoLinkError('just a string')).toEqual({
      title: 'Something went wrong',
      body: 'just a string',
      raw: 'just a string',
    });
  });

  // path only interpolates; it never decides which copy is used.
  it('uses a neutral placeholder when a known code arrives without a path', () => {
    const copy = describeRepoLinkError(
      new ApiError('repoPath does not exist', 'repo_path_not_found'),
    );

    expect(copy.title).toBe("That folder doesn't exist");
    expect(copy.body).toContain('That folder');
  });
});
