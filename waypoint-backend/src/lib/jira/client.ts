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
 * The abort timer covers the body read as well as the headers, not just the
 * fetch: `fetch` resolves as soon as headers arrive, so clearing the timer
 * there leaves a stalled body with no timeout at all — a hang with no error,
 * which is the worst shape a failure can take inside an MCP tool call because
 * the model just waits.
 */
export async function jiraGet<T>(
  credential: JiraCredential,
  path: string,
  query?: Record<string, string>,
): Promise<JiraResult<T>> {
  const url = new URL(`https://${credential.site}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: authorizationHeader(credential), Accept: 'application/json' },
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

export interface JiraIdentity {
  accountId: string;
  displayName: string;
  email: string;
}

/**
 * Proves a credential works, and returns the identity it belongs to.
 *
 * `/myself` is the right probe: it needs no permission beyond being a valid
 * session, so a credential that passes here has genuinely authenticated
 * rather than merely failed to be rejected by an endpoint that 200s for
 * anyone.
 */
export async function validateCredential(credential: JiraCredential): Promise<JiraResult<JiraIdentity>> {
  const result = await jiraGet<Record<string, unknown>>(credential, '/rest/api/3/myself');
  if (!result.ok) return result;

  const me = result.value ?? {};
  const accountId = typeof me.accountId === 'string' ? me.accountId : '';
  if (!accountId) {
    return failure(
      'site_not_found',
      'That address answered, but not like a Jira Cloud site — check the site address.',
    );
  }
  return {
    ok: true,
    value: {
      accountId,
      // Atlassian hides emailAddress unless the account's profile visibility
      // allows it, so the address the user typed is the reliable one to keep.
      email: typeof me.emailAddress === 'string' && me.emailAddress ? me.emailAddress : credential.email,
      displayName:
        typeof me.displayName === 'string' && me.displayName ? me.displayName : credential.email,
    },
  };
}
