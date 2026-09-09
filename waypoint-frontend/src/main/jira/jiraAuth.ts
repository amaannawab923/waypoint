import * as fs from 'fs';
import * as path from 'path';
import { app, safeStorage } from 'electron';
import type { JiraIdentity } from './jiraTypes';

// The Jira Cloud API-token credential store. Same shape as
// copilot/copilotAuth.ts's token store — Electron's safeStorage (OS keychain /
// libsecret / DPAPI) to encrypt, a 0o600 file under app.getPath('userData')
// to hold the ciphertext, and a hard refusal when
// safeStorage.isEncryptionAvailable() is false rather than a plaintext
// fallback — but a deliberately SEPARATE module and a separate file on disk.
// The two credentials are unrelated (one is an Anthropic inference token, the
// other is an Atlassian API token scoped to a specific person on a specific
// site), have different lifetimes, and are cleared independently; sharing one
// blob would mean disconnecting Jira could invalidate a Copilot login.
//
// Why this lives in the main process at all, rather than in waypoint-backend:
// the backend is a separate Express process whose own HTTP surface has no
// authentication boundary (src/middleware/ is asyncHandler/errorHandler/errors
// and nothing else), so a live Jira credential held there would sit on a local
// port anything else on the machine could reach. Main already holds exactly
// this class of secret for Copilot, behind IPC that only this app's own
// renderer can speak.
//
// An API token is a real bearer credential for the user's whole Jira account.
// It is never logged, never returned to the renderer, and the only outbound
// destination it is ever sent to (over HTTP) is the one site hostname stored
// alongside it (see jiraClient.ts).
//
// That is NOT the same as "never exposed at all". agent/sessionPolicy.ts and
// agent/claudeSession.ts bake the encoded credential into the MCP server
// config handed to the Claude Agent SDK for every Copilot turn, and the SDK
// serializes that config into the spawned CLI subprocess's own argv
// (`--mcp-config <json>` — confirmed against the vendored SDK, not assumed).
// Process arguments are readable by any other process running as the same
// OS user (e.g. /proc/<pid>/cmdline on Linux, `ps -ww` on macOS) — a wider
// boundary than the loopback HTTP traffic this module's other comments
// describe, and same-uid local code is exactly the adversary the keychain
// encryption above exists to defend against. Tracked as a known gap, not
// something this module actually closes today.
//
// Two directions exist, and they close different parts of the gap, at
// different costs. The vendored CLI's own `--mcp-config <configs...>`
// accepts a path to a JSON file, not only an inline JSON string (confirmed
// in its own bundled help text, not assumed) — but reaching that path
// is not a small swap: the SDK's typed `mcpServers` option always
// JSON-stringifies inline (confirmed against its own argv-building code),
// so using a file path means abandoning that option and routing through
// the SDK's separate `extraArgs?: Record<string, string | null>` escape
// hatch instead. Doing so would keep the credential out of argv, closing
// cross-user visibility (`ps` on another account, a crash reporter or APM
// tool that captures argv but not a temp file's contents) — but it would
// NOT close the same-uid threat this comment opens with (a 0600 temp file
// is exactly as same-uid-readable as argv is), and it is not free even for
// what it does close: today the plaintext credential exists ONLY in this
// process's memory and its own keychain-encrypted file; a temp file adds a
// second, unencrypted on-disk copy for the life of each Copilot turn — a
// new surface for a backup daemon, a tmp-scraping crash collector, or
// forensic disk recovery, and one that survives past a crash if cleanup
// doesn't run. The other direction — routing the credential through a
// short-lived redemption token instead of baking the real value into the
// spawned config at all — is what actually closes the same-uid threat, at
// the cost of a real design change (main would need to hand the backend a
// way to redeem a token back to the real credential, not just receive one).
// Neither is implemented yet; the redemption token is the one worth doing
// if only one gets done, and it has no on-disk-plaintext cost the file-path
// swap does.

const CREDENTIAL_FILE_NAME = 'jira-auth.json';

// A second, deliberately UNENCRYPTED file beside the credential itself. It
// carries no secret — just the fact "the last real Jira call against this
// credential came back 401" — so encrypting it would buy nothing while
// costing every write a safeStorage round trip on the hot path of a failed
// request. See jiraClient.ts's performRequest for the one place that sets it
// and jiraIpc.ts's `jira:status` handler for the one place that reads it:
// a purely local file is still what answers `jira:status`, this just gives
// that file a second thing to say ("connected" is no longer good enough once
// Atlassian has revoked the token out from under it).
const INVALID_MARKER_FILE_NAME = 'jira-auth-invalid.json';

function invalidMarkerFilePath(): string {
  return path.join(app.getPath('userData'), INVALID_MARKER_FILE_NAME);
}

/**
 * Flags the stored credential as no longer good, without touching the
 * credential itself. Called the moment a real Jira API call gets a 401 back
 * (see jiraClient.ts) — a revoked or expired token isn't rediscovered until
 * the next such call, but from that moment on `jira:status` must stop saying
 * "connected" about a site that has already said no.
 *
 * Deliberately does not delete the credential the way `jira:disconnect`
 * does: a 401 is Jira's word today, not the user's decision, and the
 * connect form on reconnect still wants the site/email this credential
 * remembers rather than an admin retyping them from scratch.
 *
 * Best-effort: a write failure here (full disk, read-only userData) must not
 * turn a 401 into a crash of the request that surfaced it. Worst case, the
 * next `jira:status` read is stale by one call and this same 401 recurs on
 * the next real request, which tries again.
 */
export function markJiraCredentialInvalid(): void {
  try {
    fs.writeFileSync(
      invalidMarkerFilePath(),
      JSON.stringify({ invalid: true }),
    );
  } catch {
    // See the function comment: best-effort, not load-bearing for the
    // request that triggered it.
  }
}

/** Clears the 401 flag. Called wherever a credential becomes trustworthy
 * again — `jira:connect`'s own write on a freshly validated credential — so
 * a marker left over from a dead token does not outlive the token it was
 * about. */
export function clearJiraCredentialInvalidMarker(): void {
  try {
    fs.unlinkSync(invalidMarkerFilePath());
  } catch {
    // Already gone — the common case, since most credentials never get
    // flagged at all.
  }
}

/** Whether the stored credential has been flagged since it was last written.
 * Absence of the marker file — no read, ENOENT, malformed JSON — all mean
 * "not flagged," matching `readStoredJiraCredential`'s own collapse of every
 * failure mode to the same "nothing to report" answer. */
export function isJiraCredentialMarkedInvalid(): boolean {
  try {
    const raw = fs.readFileSync(invalidMarkerFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { invalid?: boolean };
    return parsed.invalid === true;
  } catch {
    return false;
  }
}

/**
 * Everything needed to authenticate as this user, stored as a single
 * encrypted blob. `email` is in here rather than in plaintext next to the
 * ciphertext on purpose: with `site` it identifies a real person's Atlassian
 * account, and it's also half of the Basic-auth pair, so it gets the same
 * protection the token does.
 */
export interface JiraCredential {
  site: string;
  email: string;
  apiToken: string;
  accountId: string;
  displayName: string;
  avatarUrl: string | null;
}

function credentialFilePath(): string {
  return path.join(app.getPath('userData'), CREDENTIAL_FILE_NAME);
}

/** Mirrors copilotAuth.ts's own guard: without OS-level encryption there is
 * no safe place to put this, and writing it in the clear is not an acceptable
 * fallback for a credential that can read and write someone's whole Jira. */
export function isJiraSecureStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The stored credential, or null if there isn't one (or it can't be read).
 * Every failure mode — no file, malformed JSON, encryption unavailable, a
 * blob that decrypts to something that isn't a credential — collapses to
 * null, exactly like copilotAuth.ts's readStoredToken: callers treat "no
 * usable credential" as "not connected", and there is no partially-usable
 * state worth distinguishing.
 */
export function readStoredJiraCredential(): JiraCredential | null {
  try {
    const raw = fs.readFileSync(credentialFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { encrypted?: string };
    if (!parsed.encrypted) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const decrypted = JSON.parse(
      safeStorage.decryptString(Buffer.from(parsed.encrypted, 'base64')),
    ) as Partial<JiraCredential>;
    if (
      !isNonEmptyString(decrypted.site) ||
      !isNonEmptyString(decrypted.email) ||
      !isNonEmptyString(decrypted.apiToken) ||
      !isNonEmptyString(decrypted.accountId)
    ) {
      return null;
    }
    return {
      site: decrypted.site,
      email: decrypted.email,
      apiToken: decrypted.apiToken,
      accountId: decrypted.accountId,
      displayName: isNonEmptyString(decrypted.displayName)
        ? decrypted.displayName
        : decrypted.email,
      avatarUrl: isNonEmptyString(decrypted.avatarUrl)
        ? decrypted.avatarUrl
        : null,
    };
  } catch {
    return null;
  }
}

/** Throws on a locked keychain or a full disk — callers are expected to catch
 * and report, not to let the failure escape as an unsettled IPC invoke (the
 * exact hazard copilotAuth.ts's save handler documents). */
export function writeStoredJiraCredential(credential: JiraCredential): void {
  // The refusal the module comment promises, in the module it describes.
  // It lived only in the one IPC caller, so the store failed closed by
  // accident rather than by construction — and a second caller added later
  // would have inherited nothing. `readStoredJiraCredential` already checks
  // the same thing on the way out; this is the matching half.
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Secure storage is unavailable on this device, so the Jira API token cannot be saved.',
    );
  }

  const encrypted = safeStorage
    .encryptString(JSON.stringify(credential))
    .toString('base64');
  const filePath = credentialFilePath();
  fs.writeFileSync(filePath, JSON.stringify({ encrypted }), { mode: 0o600 });
  // `mode` in writeFileSync applies only when the file is CREATED; on an
  // existing file it is ignored outright, so a jira-auth.json left behind at
  // 0644 by an earlier build, a restored backup, or a copy that did not
  // preserve permissions kept that mode forever while this code read as
  // though it were enforcing 0600. chmod every time makes the comment above
  // true on the rewrite path as well as the create path.
  fs.chmodSync(filePath, 0o600);
  // A credential only reaches here after jiraIpc.ts's `jira:connect` has
  // already proven it live against `/myself` — so whatever the PREVIOUS
  // credential's 401 flag said is now stale information about a token this
  // one has replaced.
  clearJiraCredentialInvalidMarker();
}

export function deleteStoredJiraCredential(): void {
  try {
    fs.unlinkSync(credentialFilePath());
  } catch {
    // Already gone — disconnecting an already-disconnected account is a
    // no-op, not an error.
  }
  // A flag about a credential that no longer exists is nothing worth
  // keeping around for the next one.
  clearJiraCredentialInvalidMarker();
}

/**
 * The header the credential is lent over. Named here, beside the encoder, so
 * a name and an encoding cannot be changed independently of each other.
 *
 * Duplicated on the backend (lib/jira/credentialHeader.ts) rather than
 * shared: two npm projects, no shared package, no build that emits anything
 * importable across them. The two are kept in step by that file's own test.
 */
export const JIRA_CREDENTIAL_HEADER = 'x-waypoint-jira-credential';

/**
 * The credential, encoded for the `x-waypoint-jira-credential` header, or
 * null when nothing is connected.
 *
 * It lives here rather than at either call site because there are now TWO of
 * them, and they must agree byte for byte: sessionPolicy.ts bakes this into
 * the MCP config so Copilot's tools can READ Jira, and copilot/
 * proposalApproval.ts attaches it to an approve POST so an approved proposal
 * can WRITE. One encoder means the backend's single parser
 * (lib/jira/credentialHeader.ts) has one shape to accept.
 *
 * Base64 of JSON, and the encoding is load-bearing rather than decorative: an
 * HTTP header value may only carry visible ASCII (RFC 9110 field-value),
 * while an email, a token and a person's own display name are arbitrary
 * user-supplied strings. Raw JSON would be rejected outright by the transport
 * for a non-ASCII value, or would carry a newline into the header block.
 * Base64's alphabet is fixed and header-safe by construction, which removes
 * the escaping question rather than answering it. It is ENCODING, NOT
 * encryption — the token is cleartext to anything that can read the request,
 * which is AT MINIMUM the loopback trust boundary the backend already rests
 * on. It is wider than that for this function's other caller specifically:
 * sessionPolicy.ts bakes this same encoded value into the MCP config that
 * ends up in the spawned Claude Code subprocess's own argv (see this file's
 * module comment above for the full account) — proposalApproval.ts's caller
 * does not have that problem, since it attaches the header to a normal
 * in-process fetch.
 *
 * Four fields, and no more. site/email/apiToken authenticate the request.
 * displayName authenticates nothing: it is there so a write-approval card can
 * say WHOSE Jira account a proposal will post as — "posts as Max Chen", not
 * "posts as yourteam.atlassian.net" — which the other three cannot answer in
 * a form a person reads. It is already held in memory beside the email that
 * has always been sent, so this is not new exposure. accountId and avatarUrl
 * stay behind: they are this app's own identity display and the backend has
 * no use for them.
 */
export function encodeJiraCredentialHeader(
  // Taken as an argument rather than read from the store inside, so that
  // "which credential" stays visible at each call site and this stays a pure
  // function of it — testable on its own terms, and impossible to make do a
  // surprise disk read.
  credential: JiraCredential | null,
): string | null {
  if (!credential) return null;
  return Buffer.from(
    JSON.stringify({
      site: credential.site,
      email: credential.email,
      apiToken: credential.apiToken,
      displayName: credential.displayName,
    }),
  ).toString('base64');
}

/** The renderer-safe projection of a credential. This is the ONLY shape that
 * ever crosses IPC: it is the credential minus `apiToken`, and keeping the
 * conversion in one named function is what makes "the token never leaves the
 * main process" checkable rather than a convention. */
export function toJiraIdentity(credential: JiraCredential): JiraIdentity {
  return {
    site: credential.site,
    accountId: credential.accountId,
    email: credential.email,
    displayName: credential.displayName,
    avatarUrl: credential.avatarUrl,
  };
}
