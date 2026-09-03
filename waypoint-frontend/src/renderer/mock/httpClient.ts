// Shared fetch wrapper for mock/api.ts's HTTP-backed implementation — talks
// to waypoint-server (see /Users/amaannawab/waypoint-server). WAYPOINT_API_BASE_URL
// is inlined at build time via webpack.EnvironmentPlugin (see
// .erb/configs/webpack.config.renderer.{dev,prod}.ts).
import { showErrorToast } from '@/lib/toast';

// 14000, not Express's conventional 4000 — matches waypoint-backend's
// moved default (see its docker-compose.yml/.env.example).
const API_BASE_URL = process.env.WAYPOINT_API_BASE_URL || 'http://localhost:14000';

/**
 * Carries the backend's structured failure detail (see errorHandler.ts's
 * ValidationError branch) alongside the human message, so a caller that
 * wants to render its own copy for a specific failure keys off the stable
 * `code` instead of string-matching prose that is free to be reworded.
 * Both fields are absent for a failure that carries no code — the message
 * is still the fallback everywhere.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  opts?: { notFoundAsUndefined?: boolean; silent?: boolean },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    // Network-level failure (server unreachable, etc.) — fetch() itself
    // throws here, never reaches the status-code handling below.
    showErrorToast("Couldn't reach the server. Check your connection and try again.");
    throw new Error(`Network error: ${path}`);
  }

  // A 404 the caller explicitly expects as a valid "not found" outcome
  // (see the *AsUndefined-tagged calls in mock/api.ts) isn't a real failure
  // — no toast for it, it's normal control flow.
  if (res.status === 404 && opts?.notFoundAsUndefined) return undefined as T;
  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    let message = `Request failed: ${res.status} ${path}`;
    let code: string | undefined;
    let errorPath: string | undefined;
    try {
      const body = await res.json();
      if (body?.error) message = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
      code = typeof body?.code === 'string' ? body.code : undefined;
      errorPath = typeof body?.path === 'string' ? body.path : undefined;
    } catch {
      // no JSON error body — keep the generic message, code/path stay unset
    }
    // `silent` is for callers that render this failure inline, right where
    // the user's attention already is — one bad action should produce one
    // error, not a global toast carrying the same raw text as well.
    if (!opts?.silent) showErrorToast(message);
    throw new ApiError(message, code, errorPath);
  }

  return res.json() as Promise<T>;
}

export const http = {
  get: <T>(path: string, opts?: { notFoundAsUndefined?: boolean }) => request<T>(path, undefined, opts),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown, opts?: { silent?: boolean }) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }, opts),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
