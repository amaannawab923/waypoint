// Shared fetch wrapper for data/api.ts's HTTP-backed implementation — talks
// to waypoint-server (see /Users/amaannawab/waypoint-server). WAYPOINT_API_BASE_URL
// is inlined at build time via webpack.EnvironmentPlugin (see
// .erb/configs/webpack.config.renderer.{dev,prod}.ts).
import { showErrorToast } from '@/lib/toast';

// 14000, not Express's conventional 4000 — matches waypoint-backend's
// moved default (see its docker-compose.yml/.env.example).
const API_BASE_URL =
  process.env.WAYPOINT_API_BASE_URL || 'http://localhost:14000';

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
    // `silent`: a background poll shows its failure in its own surface
    // (the sessions store's `error`), not as a toast every 30 s.
    if (!opts?.silent)
      showErrorToast(
        "Couldn't reach the server. Check your connection and try again.",
      );
    throw new Error(`Network error: ${path}`);
  }

  // A 404 the caller explicitly expects as a valid "not found" outcome
  // (see the *AsUndefined-tagged calls in data/api.ts) isn't a real failure
  // — no toast for it, it's normal control flow.
  if (res.status === 404 && opts?.notFoundAsUndefined) return undefined as T;
  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    let message = `Request failed: ${res.status} ${path}`;
    try {
      const body = await res.json();
      if (body?.error)
        message =
          typeof body.error === 'string'
            ? body.error
            : JSON.stringify(body.error);
    } catch {
      // no JSON error body — keep the generic message
    }
    if (!opts?.silent) showErrorToast(message);
    throw new Error(message);
  }

  return res.json() as Promise<T>;
}

export const http = {
  get: <T>(
    path: string,
    opts?: { notFoundAsUndefined?: boolean; silent?: boolean },
  ) => request<T>(path, undefined, opts),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /**
   * ROAD-162 (attachments). Uploads one file as a RAW body rather than
   * multipart/form-data, deliberately: the backend has no multipart parser
   * and adding one (multer/busboy) would be a new dependency and a new
   * parser to trust for the sake of a single-file endpoint. A raw body with
   * the filename in a header needs neither — express.raw() is already part
   * of body-parser — and one request carries exactly one file, which is
   * what the UI uploads anyway (each dropped file gets its own request and
   * its own progress bar).
   *
   * XMLHttpRequest, not fetch: upload progress. fetch() still has no
   * request-side progress event in Chromium, and a file big enough to be
   * worth a progress bar is exactly the case this endpoint exists for.
   *
   * The filename goes out percent-encoded because a header value is
   * latin-1 by spec and real filenames are not (an emoji or an accented
   * character in a header throws before the request is ever sent). The
   * server decodes it — see attachments.routes.ts.
   */
  upload: <T>(
    path: string,
    file: File,
    opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE_URL}${path}`);
      // An empty or unknown `file.type` (common for files with no
      // extension, and for some drag sources) must not go out as an empty
      // header — the server treats a missing type as this same default.
      xhr.setRequestHeader(
        'content-type',
        file.type || 'application/octet-stream',
      );
      xhr.setRequestHeader('x-waypoint-filename', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && opts?.onProgress) {
          opts.onProgress(e.loaded / e.total);
        }
      };
      const fail = (message: string) => {
        showErrorToast(message);
        reject(new Error(message));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as T);
          } catch {
            fail(`Upload succeeded but the server's reply was unreadable.`);
          }
          return;
        }
        let message = `Upload failed: ${xhr.status}`;
        try {
          const body = JSON.parse(xhr.responseText);
          if (body?.message) message = body.message;
          else if (typeof body?.error === 'string') message = body.error;
        } catch {
          // no JSON error body — keep the generic message
        }
        fail(message);
      };
      xhr.onerror = () =>
        fail("Couldn't reach the server. Check your connection and try again.");
      // Distinct from onerror: an abort is the person's own doing (they hit
      // the X on the progress row), so it rejects WITHOUT a toast — there
      // is nothing to tell them that they did not just do themselves.
      xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
      opts?.signal?.addEventListener('abort', () => xhr.abort());
      xhr.send(file);
    }),
};

/** The base every attachment URL is built from — exported so `data/api.ts`
 * can build `<img src>`/download hrefs that point at the same server every
 * other call in this file already talks to. */
export const HTTP_API_BASE_URL = API_BASE_URL;
