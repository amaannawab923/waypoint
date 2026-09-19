# Accounts & teams architecture — for the Quiet Invite flow

Status: design doc, written against code, post-spec. Supersedes
`docs/design/waypoint-accounts-and-teams.md`'s sequencing and hosting-model
assumptions (that doc's technical shape — Clerk, `req.member` middleware,
per-member Jira credentials, schema additions — is kept and reconciled
below; its "Personal and Team fork together at launch" framing is not: the
actual product spec is lazy and phased). Companion reading, already
committed: `docs/product/onboarding/onboarding-final.html` (the 14-step
spec — the source of truth for every UX claim below), the reasoning in
`docs/product/onboarding/monetization-design.md` and
`docs/product/research-approach-a-quiet-invite.md` §7–8.

This doc exists to answer one question concretely: what has to be built,
where, for `onboarding-final.html` steps 5→14 to be a real product instead
of a mockup — hosting, auth, schema, billing, and the specific new UI
surfaces the spec requires that don't exist in the codebase today.

## 0. What the mockup actually requires, restated as a build

Personal ships with **zero** account ceremony — no change to today's
single-tenant, no-auth desktop app. A Team workspace is created **only**
at the moment someone clicks "Invite your team" (sidebar nav item, step
3) or resolves an unmatched Assignee name (step 5) — never at first
launch. That click asks for one field (workspace name, step 6), then a
one-time system-browser OAuth sign-in (step 7) that returns to the app
automatically. The resulting workspace is free, unlimited members, with a
30-day confirmed Review-history window gating two placeholder-priced
paid tiers (step 12). A separate $5/mo confirmed Sync add-on lives only
in Settings → Devices & Sync (step 14), reusing the identical OAuth
mechanism but never appearing near the invite or paywall screens. A
milestone nudge (step 4) is committed v1 scope, not deferred.

Everything below is organized around making each of those steps real.

## 1. Reconciling the earlier design doc

`waypoint-accounts-and-teams.md` got the technical shape right and the
product sequencing wrong. Concretely, keep:

- Clerk as the auth provider (re-evaluated in §3, still the right call).
- `req.member` middleware replacing `CURRENT_USER_ID`.
- Per-member Jira credential storage replacing `jira-auth.json`.
- The `workspaces`/`members` schema, extended rather than redesigned.

Discard or rework:

- **The "Just for me" / "Set up my team" fork right after sign-in.**
  There is no sign-in at first launch at all. The fork the spec actually
  has is: does a workspace exist locally with no `clerkOrgId` (Personal,
  unauthenticated, today's behavior) or has this install signed in to join
  or create a Team workspace (`clerkOrgId` set)? Personal never sees a
  Clerk sign-in screen unless the user separately turns on Sync.
- **"The backend gains real network exposure... `HOST` stops being
  127.0.0.1 by default."** Still true, but scoped down: it's true only for
  the **hosted** multi-tenant backend Waypoint runs for Team + Sync (§2).
  Personal's local backend (today's `npm run dev` / packaged app talking to
  a bundled or self-hosted Postgres) keeps its `127.0.0.1` default
  unconditionally — nothing about Personal's threat model changes.
- **`db/seed.ts` "shrinks to migrations only."** Seed still needs to seed
  a Personal, unauthenticated `mem-1`/`ws-1` pair for local dev and for
  every Personal install — that path doesn't go away, Team is additive to
  it.
- Section 8's "a downloaded build signs in and chooses solo or team in
  under a minute" is no longer the acceptance bar — replace with: a
  downloaded build opens straight to Home with no sign-in, and a person
  who clicks Invite is signed in and has a working Team workspace within
  the same flow, in under a minute, without ever touching Personal's data.

## 2. Hosting model

**Two backends, not one, and Personal's doesn't change.**

- **Personal** keeps running exactly as today: `waypoint-backend`
  (`waypoint-backend/src/index.ts`) bound to `127.0.0.1` by the existing
  default (`const host = process.env.HOST || '127.0.0.1'`), talking to a
  local Postgres — either `npm run dev` against a host Postgres, or the
  existing `waypoint-backend/docker-compose.yml` (verified: binds
  `127.0.0.1:15432:5432` and `127.0.0.1:14000:14000` on the host side; the
  `api` container's `HOST=0.0.0.0` is an in-container bind that stays
  off the LAN via that same compose file's loopback-only publish rule —
  confirmed by reading both the compose file and `index.ts`/`app.ts`'s own
  comments). This path has **no auth today** (`app.ts`: "no auth — there's
  still none in this phase," CORS-origin-restricted only) and none of this
  doc changes that for Personal.
- **Hosted** is a new, second deployment of the same `waypoint-backend`
  codebase (a `HOSTED=true`-flavored build or a separate entry point —
  decide at implementation time, not a fork of the code), reachable over
  the public internet, that exclusively serves Team workspaces and the
  Sync add-on. This is the piece that doesn't exist yet:
  - TLS termination at a real hostname (the mockup's own copy already
    commits to one: `accounts.waypoint.sh` for sign-in,
    `app.waypoint.sh/join/...` for invite links — a managed load
    balancer or a reverse proxy like Caddy/Cloudflare in front of the
    container is sufficient, no custom cert handling needed).
  - A deployment target: a small managed Postgres (RDS/Neon/Supabase-class,
    not the docker-compose `postgres` service) plus a container host
    (Fly.io/Render/ECS-class — pick one during Phase 1, not a hard
    requirement of this doc) for the `api` process, running with
    `HOST=0.0.0.0` behind that TLS layer, the same way
    `docker-compose.yml`'s `api` service already runs today, just no
    longer kept off the public internet by a loopback-only publish rule.
  - **How the desktop app finds it.** Today the app has no concept of a
    remote backend URL at all — everything assumes `localhost:14000`
    (grep confirms no `backendUrl`/`apiBaseUrl` config surface exists in
    `waypoint-frontend/src/main` or `src/renderer` today). This needs a
    small new main-process config module (sibling to
    `waypoint-frontend/src/main/jira/jiraAuth.ts` in spirit, not in file):
    the Personal/local backend URL stays hardcoded to `localhost:14000`
    for all of today's tickets/projects/sessions traffic; a **second**
    base URL, defaulting to the hosted endpoint, is used exclusively for
    Clerk auth calls and any request scoped to a Team `workspaceId`. The
    renderer never picks the URL itself — main resolves it per-request the
    same way it already gates Jira calls through `borrowedCredential.ts`'s
    header pattern.
  - Self-hosters (§8) override the hosted URL with their own, at which
    point their single self-hosted backend serves both Personal and Team
    traffic — this is why the desktop app's config needs to be a real
    override, not a build-time constant.

**Open cost/ops question, explicitly not resolved here:** whether
Personal-mode installs *optionally* live on the hosted backend as a
single-member workspace (so Sync has somewhere to go without also forcing
Team's multi-tenant model) or Personal stays permanently local-only and
Sync is a distinct sync target. §6/§9 take a position on this for schema
purposes; it is a real infra-cost decision for whoever owns the hosted
Postgres bill, not settled by this doc.

## 3. Auth

**Superseded 2026-09-14 by
[`docs/design/self-hosted-auth-and-multitenancy.md`](self-hosted-auth-and-multitenancy.md):**
the Clerk recommendation below is reversed. Building and running the
self-hosted team backend on docker-compose *before* any cloud deployment
exists (`docs/decisions/001-product-shape-and-distribution.md` §4) means
sign-in itself can't depend on a third-party SaaS account — this section's
own §8 flags that exact problem ("Clerk itself is still a hosted
dependency even in a self-hosted deployment") without resolving it. The
new doc replaces Clerk with built-in auth (operator-supplied GitHub/Google
OAuth client IDs, operator-supplied SMTP for email magic links, sessions
in our own Postgres) and a `users`/`members` schema split the section
below doesn't have. The `req.member` middleware shape and the
workspace-scoping audit findings below (§4) are correct and carried
forward unchanged — only what resolves `req.member` changes. Kept below
for the historical record of the Clerk evaluation; do not build against
this section.

### Provider: keep Clerk, re-affirmed against the actual requirement

The requirement changed from "solo vs. team fork at every sign-up" to
"one sign-in screen, reused identically three times: the inviter at step
7, every invitee at step 9, and Sync in Settings — GitHub / Google /
email-link, never a password." Re-evaluated against that:

- **Clerk Organizations still map directly onto `workspaces`/`members`.**
  A Clerk `User` can exist with zero Organizations (exactly the Sync-only
  case: someone turns on Sync without ever inviting a team) or with one
  Organization (the Team case) — nothing about the leaner spec requires
  giving that up. Clerk's prebuilt `<OrganizationSwitcher>` and invite UI
  are still real engineering time saved on the exact surfaces steps 6–11
  need built (name-a-workspace modal, sign-in card, invite-link screen,
  join screen).
- **WorkOS AuthKit** (the doc's noted runner-up) remains workable and has
  more direct Electron-desktop documentation, but its Organizations
  primitive is a secondary feature next to Clerk's, and this spec now
  leans on Organizations for both Team creation *and* the free/paid
  member-role model — Clerk's the better fit for that specific shape,
  not just a generic "pick one" call.
  A hand-rolled service modeled on emdash's own `auth.emdash.sh`
  (`/Users/amaannawab/emdash/apps/emdash-desktop/src/core/features/account/`)
  was considered and rejected for the same reason the prior doc rejected
  it: real infra investment pre-launch, and Clerk's free tier covers a
  pre-revenue launch's volume.
- **Recommendation: Clerk, unchanged from the prior doc**, for the same
  three reasons (Organizations-native, prebuilt UI, generous free tier),
  now explicitly re-verified against the leaner "one screen, three
  reuses" requirement rather than the discarded launch-day fork.

### The system-browser + protocol-handler flow — concrete mechanism

The mockup's own copy says the app "picks the session up automatically
through its own protocol handler, the way emdash and Zed do it." Read
against emdash's actual implementation
(`/Users/amaannawab/emdash/apps/emdash-desktop/src/main/core/shared/oauth-flow.ts`),
that phrase is imprecise in one load-bearing way worth correcting before
anyone builds from the copy literally: **emdash does not use a registered
custom URL scheme for the OAuth return leg.** It uses a PKCE flow against
an ephemeral **loopback HTTP server** (`http.createServer(...).listen(0,
'127.0.0.1', ...)`, callback path `/callback`, `state`/`code_challenge`
validated locally) — `shell.openExternal()` opens the system browser to
the provider's hosted sign-in page with a one-time `redirect_uri` pointed
at that loopback port, and the browser redirects straight back to it on
success. Waypoint's own `app://waypoint` custom scheme
(`waypoint-frontend/src/main/main.ts`, `protocol.registerSchemesAsPrivileged`
/ `protocol.handle('app', ...)`) exists today only to serve the packaged
renderer bundle — it is not currently wired to anything OAuth-shaped, and
does not need to be: the loopback approach avoids OS-level scheme
registration and collision entirely, and is the mechanism to copy.

Concretely for Waypoint:

1. Main process (new module, alongside `jiraAuth.ts`) starts a one-shot
   loopback server on an OS-assigned port, generates PKCE verifier/
   challenge and a `state`.
2. `shell.openExternal()` opens Clerk's hosted sign-in page
   (`accounts.waypoint.sh/sign-in?for=<workspace-slug>` per the mockup's
   own URL, step 7) with `redirect_uri=http://127.0.0.1:<port>/callback`.
3. Clerk completes GitHub/Google/email-link sign-in in the browser and
   redirects to the loopback callback with a code.
4. Main exchanges the code server-side (against Clerk's token endpoint,
   never exposing the exchange to the renderer) for a session token,
   closes the loopback server, and shows the "signed in as \<name\>"
   state the mockup's step 8 draws.
5. The renderer never sees the token — same boundary
   `jiraAuth.ts`'s module comment already documents for the Jira
   credential, and the same reasoning applies here even more directly
   (a Clerk session token is a bearer credential for a real hosted
   account, not a scoped API token).

**Sync's sign-in (Settings → Devices & Sync, step 14) is the identical
flow**, called with a different `for=` context (no workspace to name
first) — one OAuth client module serving both callers, per the
monetization doc's explicit intent ("reuses the same one-time OAuth
pattern as the team invite rather than inventing a second identity
mechanism").

### Session token storage

`safeStorage`-encrypted, beside `jiraAuth.ts`'s existing pattern
(`waypoint-frontend/src/main/jira/jiraAuth.ts` is the concrete file-shape
to mirror: a dedicated module, a dedicated on-disk file — not shared with
the Jira blob, same reasoning as that module's own comment on why Jira
and Copilot credentials don't share one file), revalidated against Clerk
on launch. Main attaches it to every request scoped to a Team
`workspaceId` or a Sync call; the renderer only ever sees a signed-in/
signed-out projection, matching `toJiraIdentity()`'s renderer-safe-view
precedent in the same file.

## 4. Backend: `req.member` and the workspace-scoping audit

### The middleware

A new Express middleware resolves a Clerk session token (sent on hosted-
backend requests only — Personal's local backend never sees one) to a
`members` row via Clerk's Node SDK (server-side JWT verification, no
custom crypto), replacing the direct `CURRENT_USER_ID`/`WORKSPACE_ID`
imports from `waypoint-backend/src/lib/currentUser.ts`. Personal's local
backend keeps using the literal constants unmodified — this middleware
only exists on the hosted deployment's code path.

### Every real call site, from the actual grep (not the prior doc's list)

`grep -rn CURRENT_USER_ID waypoint-backend/src waypoint-frontend/src`,
verified directly against this checkout:

| File | What it does today | What changes |
|---|---|---|
| `waypoint-backend/src/db/seed.ts` | Hardcodes `mem-1`/`ws-1` for local dev seed data | Unchanged — Personal-only, stays as-is (§1) |
| `waypoint-backend/src/routes/copilot.routes.ts` | Lists/creates Copilot conversations, resolves note conversations, for `CURRENT_USER_ID` | On hosted: `req.member.id` |
| `waypoint-backend/src/services/comments.service.ts` | Comment `authorId`, activity `actorId` | `req.member.id`, threaded through the service's caller |
| `waypoint-backend/src/services/agentAssignments.service.ts` | Looks up "me" (`members` row) for assignment logic | `req.member.id` |
| `waypoint-backend/src/services/members.service.ts` | `getCurrentUser`/`updateCurrentUser`, **and `listMembers()`, which today has no `WHERE` clause at all — `db.select().from(members)` returns every member in the database, not just the current workspace's** | `req.member.id` for current-user ops; `listMembers()` gains a mandatory `where(eq(members.workspaceId, req.member.workspaceId))` — this is a real cross-tenant leak today, latent only because there is exactly one workspace in the database; it becomes exploitable the moment a second workspace exists |
| `waypoint-backend/src/services/scratchNotes.service.ts` | Scratch note `authorId`, and its list query filters by `authorId` only, not `workspaceId` | `req.member.id`; audit whether scratch notes need a `workspaceId` filter too, since two members of two different workspaces are still distinguished by `authorId` alone today only because there's one workspace |
| `waypoint-backend/src/services/tickets.service.ts` | `@me` resolution (assignee/creator filters), `createdById`, and every `actorId` on activity-log writes (12+ call sites) | `req.member.id` throughout; the ticket queries themselves need a `workspaceId`/`projectId` scoping audit alongside this — see below |
| `waypoint-backend/src/services/docs.service.ts` | Doc `ownerId` | `req.member.id` |
| `waypoint-backend/src/services/agents.service.ts` | Uses both `CURRENT_USER_ID` and `WORKSPACE_ID` for `createdById` | `req.member.id` / `req.member.workspaceId` |
| `waypoint-backend/src/services/views.service.ts` | Saved view `ownerId` | `req.member.id` |
| `waypoint-backend/src/services/notifications.service.ts` | Notification list filtered by `recipientId` | `req.member.id` |
| `waypoint-backend/src/services/projects.service.ts` | Project-membership insert, uses both constants | `req.member.id` / `req.member.workspaceId` |
| `waypoint-frontend/src/renderer/data/currentUser.ts`, `data/api.ts`, `components/sessions/{BriefPreviewDialog,NewSessionDialog}.tsx` | Renderer-side literal `CURRENT_USER_ID = 'mem-1'`, used to stamp `ownerMemberId` on new sessions | Personal: unchanged. Hosted/Team: the renderer must stop hardcoding this and instead read "who am I" from the signed-in-identity projection main already exposes for Jira (§3) — a small new IPC surface, not a Wire pattern (this is `waypoint-frontend`, not `emdash`; there is no cross-project Wire contract to reuse here) |

### The workspace-scoping audit

Beyond the `CURRENT_USER_ID` call sites, every route that reads or writes
data implicitly scoped to a workspace has to filter by
`req.member.workspaceId` explicitly — checked route-by-route, not
assumed. The `listMembers()` finding above is the concrete proof this
gap is real, not hypothetical, in the current codebase. At minimum audit:
`projects.service.ts` (project listing), `tickets.service.ts` (ticket
listing/search — currently workspace-implicit because there is one
workspace), `views.service.ts` (saved views), `workstreams-sprints.ts`
schema-backed routes, and `docs.service.ts`. This is genuinely the same
work for Personal as for Team once Personal optionally lives on the
hosted backend as a single-member workspace (§2's open question) — a
single-tenant special case would have to be re-litigated later if this
audit is skipped now.

## 5. Schema changes

Building on `workspaces`/`members` (`waypoint-backend/src/db/schema/workspace.ts`,
read directly — `planTierEnum` already has `community|pro|business|
enterprise`, `memberRoleEnum` already has `admin|member|guest`,
`authMethodEnum` already has `email|google|github|gitlab|gitea`):

- `members.clerkUserId text unique, nullable` — null for a Personal
  member row (today's seeded `mem-1` shape stays valid), set once a
  person signs in via Clerk for Team or Sync. `email`/`fullName`/
  `displayName`/`avatarColor` stay columns (every existing query keeps
  working) but become Clerk-synced once `clerkUserId` is set.
- `workspaces.clerkOrgId text unique, nullable` — null for Personal,
  set for a Team workspace. This is the field that distinguishes "local,
  unauthenticated, single-member" from "hosted, Clerk-backed" at the data
  layer, replacing the discarded launch-day fork as the actual mode
  signal.
- `workspaces.plan` — `planTierEnum` needs its values reconciled with the
  monetization doc's actual tiers (`community` ≈ free Team workspace,
  but the doc's `pro`/`business`/`enterprise` don't match the spec's
  named tiers `Team Pro` / `Team Commercial`; either rename the enum
  values or add a mapping layer — a naming decision to make before
  building the billing plumbing in §6, not a blocker to flag here).
- A new column or small table backing the 30-day Review-history window:
  the simplest shape is `workspaces.reviewHistoryDays integer` (default
  30, overridden to `null`/unlimited once a workspace upgrades) rather
  than a hardcoded constant, since Team Pro's whole value proposition is
  removing this limit per-workspace. The **enforcement** point is a
  query-level filter in whatever reads Review-queue/run history (the
  proposals/review-queue services under `waypoint-backend/src/services/`
  and `routes/reviewQueue.routes.ts`/`proposals.routes.ts`), not a
  separate data-retention job — runs still exist past 30 days (the
  mockup is explicit: "42 runs... still happened, they're just not
  searchable"), so this is a read-side filter, never a delete.
- Seat counting for billing needs a live count derivable from
  `members` rows scoped to `workspaceId` with a non-guest role — no new
  column required, just a query the billing service (§6) can call.

## 6. Billing

Two confirmed prices ($5/mo Sync, and the 30-day window itself isn't
priced but gates pricing) and two placeholder seat prices ($8/$24) have
to actually charge someone. Scoped as real engineering:

- **Provider:** Stripe (not evaluated further here — no existing payment
  integration exists anywhere in this codebase to react to or extend;
  this is a from-scratch choice, and Stripe Billing's seat-based
  subscriptions and webhook model fit the seat-priced Team tiers and the
  flat-priced Sync add-on directly).
- **What has to exist, concretely:**
  - A `workspaces` (Team billing) and a `members` (Sync billing, since
    Sync is a per-install/per-person add-on, not a workspace-level one)
    Stripe Customer mapping — new columns (`stripeCustomerId`) on both
    tables, or a small `billing_accounts` join table if a workspace and
    its owning member both need independent Stripe Customers (owner pays
    for Team seats; any member could independently pay for their own
    Sync) — the latter is more honest to the spec's actual shape (Sync is
    explicitly per-device/per-person, never bundled with Team billing:
    monetization doc, "invite and pay never share a screen").
  - A webhook endpoint (new route, e.g. `webhooks/stripe.routes.ts`
    alongside the existing `webhooks.routes.ts` pattern) handling
    subscription created/updated/canceled/payment-failed events, updating
    `workspaces.plan` and `reviewHistoryDays` (or the equivalent Sync
    entitlement flag on `members`) — this is the actual gate the Review
    page's read-side filter (§5) checks, not a client-trusted flag.
  - Seat-count reconciliation: Stripe's subscription quantity has to
    track live `members` count for Team Pro/Commercial — either a
    webhook-driven sync on every invite-accepted/member-removed event, or
    a periodic reconciliation job; the invite flow (§7) has to call out
    to update Stripe quantity synchronously on accept, not just write the
    `members` row.
  - The upgrade UI itself (step 12's pricing card) posts to a new
    `POST /workspaces/:id/billing/checkout` (Stripe Checkout session,
    redirecting back into the app the same loopback-callback way OAuth
    does) and a `POST /members/:id/sync/checkout` for the Sync add-on.
- **Explicitly not scoped here:** dunning/invoice UI, proration edge
  cases, tax handling (Stripe Tax can be turned on later without an
  architecture change) — real but deferred engineering, called out so
  it isn't silently assumed away.

## 7. New UI surfaces the mockup requires

Grounded against what exists today in `waypoint-frontend/src/renderer/`:

- **Sidebar "Invite your team" nav item + explainer** (step 3). New item
  in `waypoint-frontend/src/renderer/layouts/Sidebar.tsx` (the file
  already has a `Sidebar.review-badge.test.tsx` precedent for a
  conditionally-badged nav item to follow the same pattern from), gated
  on `workspace.clerkOrgId == null` (i.e., hidden once already viewing a
  Team workspace's own sidebar, per step 10's `hideInvite` treatment in
  the mockup script). No such item or invite-modal component exists yet.
- **Assignee-field unresolved-name → invite trigger** (step 5). No
  dedicated native (non-Jira) assignee-picker component exists today —
  `JiraAssigneePicker.tsx` is Jira-specific
  (`waypoint-frontend/src/renderer/components/domain/JiraAssigneePicker.tsx`);
  the native ticket assignee field is inline wherever ticket detail
  renders it. This needs a new shared assignee-combobox component with a
  "no match → Invite '\<name\>'" trailing item, wired to the same invite
  modal the sidebar item opens.
- **Milestone-nudge trigger** (step 4, v1 scope). Needs: (a) a real
  trigger condition — the spec explicitly defers *which* metric (tickets
  closed, sessions run, days active) to post-launch usage data, so build
  the mechanism generically (a pluggable "has this milestone predicate
  fired" check evaluated on Home-page load) rather than hardcoding one
  metric; (b) a "shown once" persistence mechanism — a new
  `members`-scoped boolean/timestamp column (e.g.
  `milestoneNudgeShownAt`) is simpler and more durable across devices
  than local storage, and Personal-mode members already have a row to
  hang it on; (c) the banner component itself (Home page, no existing
  banner-with-dismiss component to reuse found in a scan of
  `waypoint-frontend/src/renderer/pages` — build new, matching the
  mockup's `.banner`/`.actions` markup).
- **Ambient Review-page "N days left" indicator** (step 12's lead-in,
  drawn as a separate ambient step in the final mockup). New, small
  component on `waypoint-frontend/src/renderer/pages/ReviewPage.tsx`
  (exists today, `ReviewPage.test.tsx` alongside it), reading
  `workspaces.reviewHistoryDays` and the oldest in-window run's age —
  only rendered when `clerkOrgId` is set and a limit is actually active
  (never on Personal, never on an unlimited-plan Team workspace).
- **Settings → Devices & Sync page** (step 14). New tab alongside the
  existing `waypoint-frontend/src/renderer/pages/profile-settings/`
  siblings (`Copilot.tsx`, `Notifications.tsx`, `Preferences.tsx`,
  `Profile.tsx`, `Security.tsx`, `Tokens.tsx` — same directory, same
  `ProfileSettingsLayout.tsx` tab-registration pattern to extend) with
  its own Enable/OAuth Sign-in row, reusing the OAuth client module from
  §3.

## 8. Self-hosting

The mockup's step 6 copy states self-hosting is "available today for
compliance and data-residency needs, same Docker Compose" — verified
against the actual compose file, **this claim is not true yet as
written.** `waypoint-backend/docker-compose.yml` today stands up exactly
one Postgres and one API container, loopback-only, with **no auth at
all** — it is a single-tenant Personal deployment, not a multi-tenant
Team-capable one. For the copy to be honest at launch, self-hosting needs
either:

1. The same Clerk-backed auth and `workspaces`/`members` multi-tenancy
   this doc builds for the hosted path, deployable via an extended
   compose file (adds `TLS`-terminating reverse proxy config and a
   `CLERK_SECRET_KEY`-shaped env var, since Clerk itself is still a
   hosted dependency even in a self-hosted deployment — worth flagging
   explicitly, since "self-hosted" here means self-hosted data and API,
   not a fully offline auth provider), or
2. A scoped-down claim: self-hosting is available today for **Personal**
   only (already true), and Team self-hosting is a stated near-term
   follow-up, not "available today."

This doc recommends (2) as the honest interim claim and (1) as a Phase
4+ deliverable (§10), rather than shipping the "available today" copy
before the compose path actually supports accounts. This is a product-
copy decision as much as an engineering one — flagging it here so it
isn't silently shipped wrong.

**Closed (AT13, ROAD-148).** Option (1) shipped, not (2) — the AT7–AT13
epic (`self-hosted-auth-and-multitenancy.md`, superseding this doc's own
Clerk-backed plan per that doc's §1) built self-hosted Team auth without
Clerk: `waypoint-backend/docker-compose.yml` now wires
`GITHUB_OAUTH_CLIENT_ID`/`_SECRET`, `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET`,
`SMTP_HOST`/`PORT`/`USER`/`PASS`/`FROM`, and `INSTANCE_SETUP_TOKEN` as
real, documented env vars, and `docs/operations/self-hosted-setup.md`
walks an operator through registering each one and completing first-run
setup. The mockup's step 6 "hosted or self-hosted" claim (see that file's
own updated `mitigation` note) is honest as of this epic, without the
scoped-down Personal-only wording this section once recommended as the
interim.

## 9. Open risks and unresolved decisions

Stated as decisions to make, not facts:

1. **Does a Personal workspace's data "become" a Team's, or does inviting
   always start a distinct, empty Team workspace?** Carried over
   unresolved from the prior design doc. **Default recommended here:**
   always start a new, empty Team workspace — matches the mockup's own
   explicit "stays local: everything already here; goes hosted: only the
   new workspace" copy on steps 6, 8, and 11 precisely (a migration would
   contradict that copy outright), and needs no migration tooling before
   launch. Flagged as a decision the founder should explicitly confirm,
   not silently inherited from the mockup copy.
2. **Does Personal optionally live on the hosted backend as a
   single-member workspace, or stay permanently local-only?** (§2) Affects
   hosted infra cost per free user and whether the workspace-scoping audit
   (§4) is "needed eventually" or "needed for every Personal user from
   day one." No default taken here — a cost/ops call, not an architecture
   one.
3. **The milestone-nudge trigger metric** — explicitly deferred to
   post-launch usage data by the spec itself (monetization doc's
   instrumentation list, item 5). The mechanism (§7) is built now; the
   metric is chosen later.
4. **`workspaces.plan` enum values vs. the spec's actual tier names**
   (§5) — a naming reconciliation to resolve before the billing work
   (§6) starts, not a structural blocker.
5. **Self-hosting's honest launch-day claim** (§8) — a product-copy
   decision with an engineering dependency, not purely either.
6. **Clerk's exact desktop redirect-URI support for a loopback callback**
   (§3) should be verified against Clerk's current documentation during
   Phase 1 implementation, not assumed from this doc — emdash's own
   pattern proves the *mechanism* works against a comparable hosted-auth
   provider, but Clerk's specific redirect-URI allow-listing rules for a
   non-fixed, OS-assigned loopback port need a concrete implementation
   check.

## 10. Work breakdown and phasing

New phase-lettering: **`AT1`–`AT6`** ("Accounts & Teams"), not an
extension of the existing `w1`…`w6` sequence found in `docs/design/`
(`w3-sessions-rail.md`, `w4-start-session.md`, `w4b-sessions-anywhere.md`,
`w5a-investigate-fix.md`, `w5b-jira-dispatch.md`,
`w5c-board-shaped-outcomes.md`). Reasoning: the `w`-series is one
continuous track (the Copilot/sessions/investigate-fix revamp), each
phase built on the runtime state the previous phase left behind. Accounts
& Teams is a materially different, mostly orthogonal subsystem — it
doesn't extend `w6`'s runtime, and numbering it `w7` would imply a
sequencing dependency on the `w`-series finishing first that doesn't
actually exist. A distinct prefix keeps that independence visible in the
ticket list itself.

Sequencing rule applied throughout: hosting/auth foundation before
anything needing a real member identity; schema before the routes that
read it; the workspace-scoping audit alongside the middleware that makes
it matter, not after.

- **AT1 — Hosting foundation.** Stand up the hosted `waypoint-backend`
  deployment (TLS, managed Postgres, container host), separate from the
  Personal/local path, with no product surface yet. Blocks everything
  else.
- **AT2 — Clerk auth: sign-in flow + session storage.** The loopback-
  OAuth main-process module (§3), `safeStorage` token persistence, the
  signed-in-identity IPC projection. No workspace creation yet — this is
  the reusable primitive both Team invite and Sync sign-in call.
- **AT3 — Schema + `req.member` middleware + workspace-scoping audit.**
  The `clerkUserId`/`clerkOrgId`/`reviewHistoryDays` migrations, the
  middleware, and the route-by-route audit including the confirmed
  `listMembers()` leak (§4). This is the ticket-sized unit most similar
  to ROAD-129's "review follow-up, real races" shape — concrete, scoped,
  security-relevant.
- **AT4 — Team workspace creation + invite flow.** Steps 6–11 of the
  mockup end to end: the name-workspace modal, Clerk Organization
  creation on sign-in return, the invite-link screen, the join flow, the
  workspace switcher, per-member Jira credential storage replacing
  `jira-auth.json` on the hosted path.
- **AT5 — Discovery UI: sidebar item, Assignee-trigger, milestone
  nudge.** Steps 3–5 — the two invite-discovery surfaces plus the
  nudge mechanism (generic predicate + shown-once persistence, §7),
  without committing to a specific trigger metric yet.
- **AT6 — Monetization: history-window enforcement, billing, Sync.**
  The read-side 30-day filter, the ambient indicator, the pricing-card
  upgrade screen, Stripe integration (§6), and the Settings → Devices &
  Sync surface with its own Sync sign-in (§7) — grouped together because
  they share the billing plumbing, even though Sync and Team-tier
  billing are visually and conceptually kept apart per the spec.

Self-hosting's multi-tenant follow-up (§8, option 1) is intentionally
left out of AT1–AT6 as a later phase, since the spec's "available today"
claim is being walked back to Personal-only (§8) rather than committed to
launch scope.
