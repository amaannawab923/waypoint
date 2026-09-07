import { pgTable, text, timestamp, index, unique } from 'drizzle-orm/pg-core';

// Everything this app knows about tickets that live in someone ELSE's
// system. Kept in its own schema file rather than folded into tickets.ts
// because none of it is a ticket: a row here is a pointer to a ticket.
//
// Note what is deliberately NOT here: a credential. This file briefly held an
// integration_credentials table, on the reasoning that Copilot's MCP tools
// run in THIS process and so need a Jira credential this process can read.
// That reasoning was right about the need and wrong about the answer — it
// made the user connect Jira twice (once in the desktop app's My Jira
// sidebar, once here) and put a live API token behind an HTTP surface with
// no auth middleware in front of it.
//
// There is now exactly one persisted Jira credential, in Electron main where
// the OS keychain protects it, and this process BORROWS it per request over
// an MCP header (see lib/jira/credentialHeader.ts). Nothing here stores a
// credential, which is why the migration that dropped this table has no
// data-preservation step: there was nothing worth keeping, only something
// worth not having.

// --------------------------------------------------------------------------
// External ticket references
// --------------------------------------------------------------------------

// One row per external ticket this app has ever resolved, which makes it two
// things at once:
//
//  1. A STABLE LOCAL HANDLE. `id` is newId('tref') — "tref-a3f9k2m" — which
//     is structurally distinct from every internal ticket id (newId('wi'),
//     see lib/ids.ts) and from every human-typed identifier ("ENG-4"). That
//     distinctness is load-bearing: get_ticket and list_comments dispatch to
//     the right provider purely by looking at the prefix of the id they were
//     handed, with no lookup table and no ambiguity to resolve.
//
//  2. A RESOLUTION CACHE. Knowing that "ENG-4" has been seen as a Jira issue
//     before is what lets get_ticket_by_identifier tell an ambiguous
//     identifier (one that names both a native ticket and a Jira issue) from
//     an unambiguous one. It is deliberately NOT a content cache: the cached_*
//     columns exist to name a ticket in an error message or a disambiguation
//     prompt, never to answer a read with. Every read still goes live, so a
//     stale row can misname a ticket in an error string but can never hand
//     the model stale ticket content.
export const ticketRefs = pgTable(
  'ticket_refs',
  {
    id: text('id').primaryKey(),
    // 'jira' today. Plain text rather than a pgEnum for the same reason
    // activity_entries.verb is (see tickets.ts): the set is expected to grow
    // and ALTER TYPE ... ADD VALUE has transactional caveats not worth
    // inheriting on a column with three possible values and no SQL filter
    // that depends on the type being closed.
    provider: text('provider').notNull(),
    // The provider's own identity for the ticket. For Jira this is the issue
    // key ("ENG-4") rather than the numeric issue id: the key is what every
    // REST path in this codebase addresses an issue by, and what a user
    // types. A key can be reassigned when an issue MOVES between projects,
    // which is exactly why nothing reads content from this table — a moved
    // issue produces a miss and a fresh live lookup, not stale data.
    externalId: text('external_id').notNull(),
    // The Jira Cloud hostname the row belongs to. Nullable per the agreed
    // schema, and worth flagging: Postgres treats NULLs in a unique
    // constraint as distinct, so a null here would silently defeat the
    // unique below. The Jira provider ALWAYS populates it — the column is
    // nullable only for a future provider with no site concept, and any such
    // provider needs its own uniqueness story rather than inheriting this one.
    externalSite: text('external_site'),
    // What a human sees and types. For Jira this equals externalId; they are
    // separate columns because that identity is a Jira coincidence, not a
    // contract every provider will keep.
    cachedIdentifier: text('cached_identifier').notNull(),
    cachedTitle: text('cached_title').notNull(),
    cachedUrl: text('cached_url'),
    // Refreshed on every successful live read. Nothing prunes on it yet;
    // it exists so a later cleanup pass has something to prune BY, and so a
    // "this looked like ENG-4 three months ago" disambiguation can say how
    // old its belief is.
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // One row per external ticket. This is what makes resolution an upsert:
    // seeing "ENG-4" for the hundredth time must refresh a row, not mint a
    // hundredth local handle for the same issue (which would break the
    // stable-handle guarantee above).
    unique('ticket_refs_provider_site_external_idx').on(t.provider, t.externalSite, t.externalId),
    // The resolution hot path: get_ticket_by_identifier asking "has anything
    // ever been seen under this identifier?" on every ambiguity check.
    index('ticket_refs_provider_site_identifier_idx').on(t.provider, t.externalSite, t.cachedIdentifier),
  ],
);
