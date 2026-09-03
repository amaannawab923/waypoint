import { ApiError } from '@/mock/httpClient';

const REPO_ERROR_COPY: Record<
  string,
  { title: string; body: (path: string) => string }
> = {
  repo_path_not_found: {
    title: "That folder doesn't exist",
    body: (p) =>
      `${p} isn't there — it may have been moved or deleted. Pick a different folder.`,
  },
  repo_path_not_directory: {
    title: "That's a file, not a folder",
    body: (p) => `${p} is a file, not a folder. Pick the folder that contains it.`,
  },
  repo_path_not_git_repo: {
    title: "That folder isn't a git repository",
    body: (p) =>
      `${p} has no .git in it. Pick the folder that contains .git — usually the top level of your checkout, one or two levels up from here.`,
  },
};

export interface RepoLinkErrorCopy {
  title: string;
  body: string;
  /** The backend's own message, kept available behind a disclosure. */
  raw: string;
}

/**
 * `code` decides WHICH copy; `path` only interpolates into it. No regex, no
 * parsing of the human message anywhere — a backend that reworded its
 * message for an unrelated reason must not silently change what the user
 * reads here.
 *
 * A failure with no code (an older backend, or a network error that never
 * reached one) falls back to the raw message under a generic title — the
 * same thing the user saw before this mapping existed, never a blank or
 * broken-looking error.
 */
export function describeRepoLinkError(err: unknown): RepoLinkErrorCopy {
  const raw = err instanceof Error ? err.message : String(err);
  if (err instanceof ApiError && err.code && REPO_ERROR_COPY[err.code]) {
    const copy = REPO_ERROR_COPY[err.code];
    return { title: copy.title, body: copy.body(err.path ?? 'That folder'), raw };
  }
  return { title: 'Something went wrong', body: raw, raw };
}
