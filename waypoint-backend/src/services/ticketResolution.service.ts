import { nativeProvider } from '../providers/native.js';
import type { JiraProvider } from '../providers/jira.js';
import { ProviderUnavailableError, type NormalizedTicket } from '../providers/types.js';

/**
 * Identifier resolution — the one place a human-typed key becomes a ticket.
 *
 * A human-typed identifier is the ONE place where a ticket's provider is
 * genuinely ambiguous. Native identifiers are minted as
 * `${project.identifier}-${sequence}` (tickets.service.ts) — the same
 * PROJECT-NUMBER shape as a Jira issue key — so "ENG-4" can perfectly well
 * name two different tickets in two different systems. Everywhere else the
 * ambiguity is already gone: once any read has returned a ticket, its `id`
 * is a prefixed internal handle ("wi-…" or "tref-…") and every downstream
 * call dispatches on that instead of re-resolving a string.
 *
 * Written once for two callers (W5b, ROAD-126): Copilot's
 * get_ticket_by_identifier tool (mcp/ticketTools.ts), where it has lived
 * since Jira reads shipped, and the desktop app's own `/investigate KEY` /
 * `dispatch_session`, which reach it through GET /tickets/resolve/:identifier
 * so a slash command on a Jira key opens the same brief a native key does.
 *
 * The ordering below is the part that matters, and it is deliberately not the
 * obvious one:
 *
 *   BOTH lookups always run. A native hit does NOT short-circuit the Jira
 *   check. Checking native first and returning early is the natural way to
 *   write this and it is wrong — it resolves an ambiguous identifier to
 *   whichever provider happened to be checked first, and nobody ever finds
 *   out there was another ticket by that name. They are issued concurrently
 *   so the property is structural rather than a fact about statement order
 *   that a later edit could quietly undo.
 *
 * The Jira side is a live point-lookup for that exact key — not a scan, and
 * not a cache read (see JiraProvider.getByIdentifier for why the ref cache
 * cannot answer it) — and it is what mints the issue's `tref-` handle, so a
 * run can name it. A cache miss therefore never means "must be native",
 * which is the specific gap this shape exists to close.
 *
 * When both match, this refuses to guess. Picking one and hoping is the worst
 * option available: right half the time, silently wrong the rest, and
 * "confidently read the wrong ticket" is a failure nobody can detect from the
 * answer.
 */

export type ResolveProvider = 'native' | 'jira';

export type TicketResolution =
  | { kind: 'found'; ticket: NormalizedTicket }
  | { kind: 'ambiguous'; native: NormalizedTicket; jira: NormalizedTicket }
  | { kind: 'missing' }
  /** Jira failed to answer and there was no native hit to fall back on. */
  | { kind: 'unavailable'; error: ProviderUnavailableError }
  /** The caller asked for Jira only, and Jira is not connected. */
  | { kind: 'jira_off' };

type Outcome<T> = { status: 'ok'; value: T } | { status: 'failed'; error: ProviderUnavailableError };

// "We did not ask", shaped as a success carrying nothing — which is what it
// is: with Jira disconnected there is genuinely no Jira ticket to find, and
// nothing failed.
const NOT_ASKED: Outcome<null> = { status: 'ok', value: null };

// Catches ONLY ProviderUnavailableError. Anything else is a bug rather than
// an integration being unreachable, and is left to the caller's safety net.
async function settled<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { status: 'ok', value: await run() };
  } catch (error) {
    if (error instanceof ProviderUnavailableError) return { status: 'failed', error };
    throw error;
  }
}

export async function resolveTicketIdentifier(
  jira: JiraProvider | null,
  identifier: string,
  provider?: ResolveProvider,
): Promise<TicketResolution> {
  // An explicit provider is an instruction, not a hint: look only there. It
  // is also how a caller answers the ambiguity outcome below.
  if (provider === 'native') {
    const item = await nativeProvider.getByIdentifier(identifier);
    return item ? { kind: 'found', ticket: item } : { kind: 'missing' };
  }
  if (provider === 'jira') {
    if (!jira) return { kind: 'jira_off' };
    const item = await jira.getByIdentifier(identifier);
    return item ? { kind: 'found', ticket: item } : { kind: 'missing' };
  }

  // Both, concurrently — see the ordering note above.
  const [nativeHit, jiraOutcome] = await Promise.all([
    nativeProvider.getByIdentifier(identifier),
    jira ? settled(() => jira.getByIdentifier(identifier)) : Promise.resolve(NOT_ASKED),
  ]);

  if (jiraOutcome.status === 'failed') {
    // Jira failed to answer, so what it would have said is unknown.
    //
    // With a native hit, return it: an optional integration having a bad
    // minute must not break a path that worked before Jira was ever
    // connected. The residual risk is real and accepted — if that identifier
    // also named a Jira issue, this silently resolves to native, which is
    // exactly what happened before this feature existed.
    //
    // Without one, refuse. "Not found" would be a positive claim resting on a
    // lookup that did not happen, and the caller would act on it.
    if (nativeHit) return { kind: 'found', ticket: nativeHit };
    return { kind: 'unavailable', error: jiraOutcome.error };
  }

  const jiraHit = jiraOutcome.value;
  if (nativeHit && jiraHit) return { kind: 'ambiguous', native: nativeHit, jira: jiraHit };
  if (nativeHit) return { kind: 'found', ticket: nativeHit };
  if (jiraHit) return { kind: 'found', ticket: jiraHit };
  return { kind: 'missing' };
}

/** The sentence an ambiguous identifier gets, wherever it is asked. */
export function describeAmbiguity(
  identifier: string,
  native: NormalizedTicket,
  jira: NormalizedTicket,
): string {
  return (
    `"${identifier}" is ambiguous: it names a Waypoint ticket ("${native.title}") ` +
    `and a Jira issue ("${jira.title}").`
  );
}
