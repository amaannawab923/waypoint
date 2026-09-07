import type { JiraCredential } from './client.js';

/**
 * The Jira credential this process reads with, and where it comes from.
 *
 * There is exactly ONE persisted Jira credential in this product, and it is
 * not here: it lives in the desktop app's Electron main process, encrypted by
 * the OS keychain, behind IPC only that app's own renderer can speak (see
 * waypoint-frontend/src/main/jira/jiraAuth.ts, whose own module comment
 * explains why it stays there — this process's HTTP surface has no auth
 * boundary, so a live API token held here would sit on a local port anything
 * on the machine could reach).
 *
 * Copilot's MCP tools run in THIS process, so a Jira read from a tool needs
 * the credential anyway. It gets it by BORROWING: main sends it as a header
 * on every MCP POST, this module turns that header into a value, and the
 * value lives only as long as the request does. Nothing in this process
 * writes it to disk, to Postgres, or to a log. The earlier shape of this
 * feature — a second credential the user connected separately, stored here
 * with at-rest encryption — is what that replaces, and the cost it removes is
 * a real one: connecting Jira twice for one integration.
 *
 * Duplicated constants (the header name, the base64-of-JSON encoding) rather
 * than shared ones, for the reason lib/jira/client.ts already documents about
 * its own overlap with the frontend's client: two npm projects, no shared
 * package, no build that emits anything importable across them. The
 * x-waypoint-conversation-id header and its id pattern are duplicated the
 * same way (see routes/mcp.routes.ts), so this follows a settled precedent
 * rather than inventing a second convention.
 */

/**
 * Base64 of the UTF-8 JSON `{site, email, apiToken}`.
 *
 * The encoding is load-bearing, not decoration. An HTTP header value may only
 * carry visible ASCII (RFC 9110 field-value), while an email and an API token
 * are arbitrary user-supplied strings — raw JSON would be rejected outright
 * by the transport for a non-ASCII token, or would carry a newline into the
 * header block. Base64's alphabet is fixed and header-safe by construction,
 * which removes the escaping question rather than answering it.
 *
 * It is ENCODING, NOT ENCRYPTION. The token is cleartext to anything that can
 * read this request — which is at minimum the same loopback trust boundary
 * the whole MCP endpoint already rests on, and the reason a general auth
 * boundary on this API is worth having on its own terms rather than being
 * half-implied here.
 *
 * It is also wider than loopback on the MCP session path specifically: the
 * desktop app bakes this same encoded value into the Claude Agent SDK's MCP
 * config, which the SDK serializes into the spawned CLI subprocess's own
 * argv — readable by any same-uid local process, not just something that can
 * intercept loopback traffic (see waypoint-frontend/src/main/jira/jiraAuth.ts
 * for the full account of that gap; it is tracked, not fixed, as of this
 * comment). The approve-path caller (copilot/proposalApproval.ts) does NOT
 * have this problem — it attaches the header to a normal in-process fetch,
 * never a subprocess argv.
 */
export const JIRA_CREDENTIAL_HEADER = 'x-waypoint-jira-credential';

/**
 * A ceiling on what will be decoded, well above any real credential (a Jira
 * API token is a few hundred characters) and well below Node's own ~16KB
 * header limit. It exists so a hostile header cannot make this allocate and
 * JSON.parse something large before the field checks reject it — cheap
 * insurance on a value that arrives from off-process.
 */
const MAX_HEADER_LENGTH = 4096;

/**
 * Reduces whatever arrived to a bare hostname, or rejects it.
 *
 * This is a security control, not a convenience, and it matters MORE now than
 * it did when the same function guarded a POST body: the site now arrives on
 * a header, on an endpoint reachable by anything on this host. The value is
 * interpolated into `https://${site}${path}` in lib/jira/client.ts, where the
 * API token rides in an Authorization header — so a "site" carrying a path, a
 * userinfo prefix, a port, or a `#` would silently retarget every
 * authenticated request. Parsing with the URL class and taking ONLY its
 * hostname is what makes that unrepresentable: `evil.com/x`,
 * `good.atlassian.net@evil.com`, and `evil.com#good.atlassian.net` all reduce
 * to the host the browser would really have contacted, and the check below
 * then decides whether to accept it.
 *
 * What this does NOT do: prevent this process from being pointed at an
 * arbitrary internal host. The dotted-label + letter-in-last-label rule below
 * excludes every IP literal (loopback included), but it accepts any
 * DNS-resolvable hostname shape — `internal-service.corp.example`,
 * `db.svc.cluster.local` — and this endpoint has no authentication in front
 * of it, so any local process can already drive a request at whatever
 * hostname it supplies (with its own Authorization header — this is a pivot,
 * not a credential leak). Closing that fully needs an explicit allowlist
 * (`*.atlassian.net` plus any configured custom Jira Cloud domains), which is
 * a real product decision (Jira Cloud does support bringing your own domain)
 * rather than something this function can safely default to. Tracked as a
 * known gap, not a claim this check makes.
 */
export function normalizeSite(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let hostname: string;
  try {
    // A bare hostname has no scheme for the URL parser to work with, so give
    // it one; an input that already carries http/https keeps its own, and
    // anything with a different scheme fails the check below.
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    // Reject rather than ignore credentials embedded in the URL: they are
    // never legitimate here, and silently dropping them would accept an input
    // whose obvious reading ("connect as this user") is not what happens.
    if (parsed.username || parsed.password) return null;
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
  // A conservative hostname shape — labels of alphanumerics and hyphens,
  // at least one dot. Deliberately excludes single-label hosts ("localhost"):
  // this connects to Jira Cloud, whose sites are always
  // <something>.atlassian.net or a customer domain, and a narrower accept is
  // the right default for a value a token gets sent to.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) return null;
  // The dotted-label shape alone still admits "127.0.0.1", which is four
  // perfectly legal labels — so an IP literal would pass as a site address
  // and point the token at loopback or at something on the internal network.
  // Requiring a letter in the last label is the general rule that excludes
  // every IPv4 literal without special-casing address syntax (IPv6 literals
  // are already out: URL keeps their brackets, which the shape rejects).
  const lastLabel = hostname.slice(hostname.lastIndexOf('.') + 1);
  if (!/[a-z]/.test(lastLabel)) return null;
  return hostname;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The lent credential, or null.
 *
 * EVERY failure collapses to null and none of them throws: absent, oversized,
 * not base64, not JSON, missing a field, a site that does not normalize. That
 * is deliberate, and it is the same rule mcp.routes.ts already applies to a
 * malformed conversation id — this endpoint is reachable by anything on
 * localhost, so a hostile or merely stale header must degrade to a state the
 * system already handles rather than producing an error.
 *
 * The state it degrades to is "Jira is not connected", which the read tools
 * have to handle regardless (most requests genuinely carry no header, because
 * most users have not connected Jira). So there is nothing to special-case:
 * a malformed header and an absent one are the same fact here.
 *
 * Nothing is logged on the failure path, not even a length or a prefix. A
 * malformed value is as likely to be a truncated real credential as a hostile
 * one, and a log line is exactly the wrong place for either.
 */
export function parseJiraCredentialHeader(raw: string | undefined): JiraCredential | null {
  if (!raw || raw.length > MAX_HEADER_LENGTH) return null;

  let decoded: unknown;
  try {
    // Buffer.from(_, 'base64') never throws — it silently drops characters
    // outside the alphabet — so garbage reaches JSON.parse rather than being
    // rejected here. That is fine: JSON.parse is the real gate, and the field
    // checks below are the one after it.
    decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }

  if (!decoded || typeof decoded !== 'object') return null;
  const { site, email, apiToken, displayName } = decoded as Record<string, unknown>;
  if (!isNonEmptyString(site) || !isNonEmptyString(email) || !isNonEmptyString(apiToken)) {
    return null;
  }

  const normalizedSite = normalizeSite(site);
  if (!normalizedSite) return null;

  // Rebuilt field by field rather than spread: whatever else the header
  // carried does not become part of a credential this process then hands to
  // the Jira client.
  //
  // displayName is the one field here that authenticates nothing. It arrived
  // with the write path, which needs to tell a reviewer WHOSE Jira account a
  // proposal will post as before they approve it — "posts as Max Chen", not
  // "posts as yourteam.atlassian.net". It is NOT required: an older desktop
  // build sends a header without it, and that is a working credential, not a
  // malformed one, so its absence must not reject the whole header. Callers
  // fall back to email.
  return {
    site: normalizedSite,
    email,
    apiToken,
    ...(isNonEmptyString(displayName) ? { displayName } : {}),
  };
}
