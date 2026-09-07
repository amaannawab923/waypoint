/**
 * A Jira Cloud REST client for THIS process.
 *
 * waypoint-frontend/src/main/jira/jiraClient.ts is a far more complete client
 * for the same API and is deliberately not reused: it is a different npm
 * project with no shared package, no monorepo tooling, and no build that
 * emits anything importable from here. Sharing it means creating a package
 * and a build step for two functions' worth of overlap, which is a bigger,
 * later decision than this read-only slice should be making on its own. What
 * IS shared is the shape of the thing — Basic auth over a pinned hostname,
 * one place that decides what a status code means — because those were
 * settled correctly there and re-deciding them differently would be the
 * actual mistake.
 *
 * Scope is deliberately narrow: three GETs. Nothing here writes to Jira, and
 * that is the point of this pass — read tools ship and are proven before any
 * write path exists.
 */

const REQUEST_TIMEOUT_MS = 20_000;

export interface JiraCredential {
  /** Bare hostname, e.g. "yourteam.atlassian.net" — no scheme, no path. */
  site: string;
  email: string;
  apiToken: string;
  /**
   * The connected account's own display name, for saying WHOSE account a
   * write will post as before anyone approves it.
   *
   * Optional, and it has to be: the header is external input, and an older
   * desktop build sends one without this field. Callers fall back to `email`,
   * which names the same account less pleasantly rather than naming nothing.
   *
   * Nothing authenticates with this. It is here for the one thing a reviewer
   * needs and the other three fields cannot tell them — reading "posts as
   * yourteam.atlassian.net" is not the same as reading "posts as Max Chen".
   */
  displayName?: string;
}

export type JiraFailureReason =
  | 'invalid_credentials'
  | 'forbidden'
  // A 404 on a specific issue: Jira answered, and its answer is "no such
  // issue". Kept distinct from every other failure because the identifier
  // resolution in mcp/ticketTools.ts turns on exactly this difference — a
  // real "not there" lets it conclude an identifier is native-only, whereas
  // any other failure means it does not KNOW and must not conclude anything.
  | 'not_found'
  | 'rate_limited'
  | 'network'
  | 'site_not_found'
  | 'jira_error';

export type JiraResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: JiraFailureReason; message: string };

function failure(reason: JiraFailureReason, message: string): JiraResult<never> {
  return { ok: false, reason, message };
}

/**
 * The one place the token becomes transmittable. Isolated so it is checkable
 * at a glance that nothing puts it in a URL, a query string, or a log line.
 */
function authorizationHeader(credential: JiraCredential): string {
  return `Basic ${Buffer.from(`${credential.email}:${credential.apiToken}`).toString('base64')}`;
}

/** Jira reports problems as `{ errorMessages: [...], errors: { field: ... } }`
 *  — its own words ("Issue does not exist") beat a status code every time. */
function messageFromErrorBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.errorMessages)) {
    const first = record.errorMessages.find((m) => typeof m === 'string' && m);
    if (typeof first === 'string') return first;
  }
  if (record.errors && typeof record.errors === 'object') {
    const first = Object.values(record.errors as Record<string, unknown>).find(
      (v) => typeof v === 'string' && v,
    );
    if (typeof first === 'string') return first;
  }
  return fallback;
}

function classifyNetworkError(err: unknown): JiraResult<never> {
  if (err instanceof Error && err.name === 'AbortError') {
    return failure('network', 'Jira took too long to respond.');
  }
  const code = (err as { cause?: { code?: string } } | undefined)?.cause?.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return failure('site_not_found', "That Jira site doesn't resolve — check the site address.");
  }
  return failure('network', "Couldn't reach Jira.");
}

/**
 * Every Jira call in this process goes through here, so there is exactly one
 * opinion about what each status code means.
 *
 * GET and POST share this body rather than each owning a copy. That is not
 * tidiness: the timeout discipline below is subtle and the status-code
 * mapping is a security-adjacent contract (a 404 means something specific to
 * the identifier resolution — see JiraFailureReason). Two copies would drift,
 * and the write path is the copy that must not.
 *
 * The abort timer covers the body read as well as the headers, not just the
 * fetch: `fetch` resolves as soon as headers arrive, so clearing the timer
 * there leaves a stalled body with no timeout at all — a hang with no error,
 * which is the worst shape a failure can take inside an MCP tool call because
 * the model just waits.
 */
async function jiraRequest<T>(
  credential: JiraCredential,
  init: {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string>;
    /** JSON-serialized as the request body. POST only. */
    body?: unknown;
  },
): Promise<JiraResult<T>> {
  const url = new URL(`https://${credential.site}${init.path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: init.method,
      headers: {
        Authorization: authorizationHeader(credential),
        Accept: 'application/json',
        // Only when there is a body: sending a content-type on a GET is
        // harmless but dishonest, and Jira is picky enough elsewhere that
        // "say exactly what this request is" is the better habit.
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return classifyNetworkError(err);
  }

  if (!response.ok) {
    // Jira answers with a JSON error body whatever was asked for, so reading
    // it here rather than per-caller is what lets a failure carry Jira's own
    // explanation instead of a bare status number.
    let parsed: unknown;
    try {
      const text = await response.text();
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) {
      return failure(
        'invalid_credentials',
        'Jira rejected the stored email and API token — reconnect Jira in settings.',
      );
    }
    if (response.status === 403) return failure('forbidden', "The connected Jira account isn't allowed to do that.");
    if (response.status === 404) {
      return failure('not_found', messageFromErrorBody(parsed, 'Jira has no such issue.'));
    }
    if (response.status === 429) {
      return failure('rate_limited', 'Jira is rate-limiting this account — try again shortly.');
    }
    return failure('jira_error', messageFromErrorBody(parsed, `Jira returned ${response.status}.`));
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    return classifyNetworkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!text) return { ok: true, value: undefined as T };
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    // A 200 that isn't JSON is not a Jira API response — almost always a
    // login page or a parked domain on a hostname that happens to answer on
    // https. Saying so beats a downstream "cannot read property of undefined".
    return failure(
      'site_not_found',
      'That address answered, but not like a Jira Cloud site — check the site address.',
    );
  }
}

export async function jiraGet<T>(
  credential: JiraCredential,
  path: string,
  query?: Record<string, string>,
): Promise<JiraResult<T>> {
  return jiraRequest<T>(credential, { method: 'GET', path, query });
}

/**
 * The write half. Same failure vocabulary as jiraGet, and that matters most
 * for the two statuses a write can produce that a read effectively cannot:
 *
 *  - 400, which for a transition POST means "that transition is not legal
 *    from this issue's current status" — a normal, user-actionable outcome
 *    (someone moved the issue between propose and approve), carrying Jira's
 *    own explanation via messageFromErrorBody. Callers turn it into a stale
 *    proposal, not an error.
 *  - 403, which on a write means the connected account may read this issue
 *    but not change it — different from "no such issue" in the one way the
 *    reviewer cares about.
 *
 * `T` is frequently `void`: Jira answers a transition POST with 204 and an
 * empty body, which jiraRequest already returns as `{ ok: true }`.
 */
export async function jiraPost<T>(
  credential: JiraCredential,
  path: string,
  body: unknown,
): Promise<JiraResult<T>> {
  return jiraRequest<T>(credential, { method: 'POST', path, body });
}

// There is deliberately no validateCredential here any more.
//
// It existed to prove a credential at CONNECT time, and this process no
// longer has a connect flow: the credential arrives already proven, borrowed
// per request from the desktop app that owns the connect flow and validates
// there (see lib/jira/credentialHeader.ts). Re-proving it here would mean an
// extra /myself round trip on every single tool call, buying nothing — a
// revoked or rotated token fails the real call with 'invalid_credentials'
// either way, which is exactly what the caller needs to hear.
