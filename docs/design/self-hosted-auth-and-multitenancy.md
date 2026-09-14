# Self-hosted auth and multi-tenancy — the real build, self-hosted first

Status: design doc, written against code, supersedes the auth-provider
choice in `docs/design/accounts-teams-architecture.md` §3 only (that
doc's `req.member`/schema/scoping-audit shape is correct and is
reconciled below, not discarded). Required reading before this doc:
`docs/decisions/README.md`, `001-product-shape-and-distribution.md` §2/§4,
`002-pricing-and-free-tier.md`, `003-open-source-licensing.md` §5/§7,
`005-open-questions.md`, and `docs/product/onboarding/onboarding-final.html`
steps 6–10.

This doc answers one question the prior doc left open: **how does sign-in
actually work when the product must be free-forever, fully-collaborative,
and Clerk-free the moment someone self-hosts it** — because 001 §4 commits
to building and running the team backend on docker-compose, daily, before
any cloud deployment exists, and 003 §5/§7 commits to no booby-trapped
open-source core. A backend whose sign-in screen requires every self-hoster
to first create a third-party Clerk account is not that.

## 1. The provider decision

**Built-in auth, the Plane/Cal.com/Grafana pattern: GitHub and Google OAuth
with operator-supplied client IDs, email magic link via operator-supplied
SMTP, sessions in our own Postgres. No third-party identity account,
required or optional, for the product to function.**

### Why not Clerk (option a, the prior doc's choice)

The prior doc's own §8 already flagged this and didn't resolve it: "Clerk
itself is still a hosted dependency even in a self-hosted deployment."
That is disqualifying against 001 §4's actual build order, not a footnote.
001 §4 says self-hosted-on-docker-compose is what we develop the *whole
product* against, every day, before cloud exists. If that path requires a
Clerk account, "self-hosted" is not self-hosted — it is "self-hosted
except for the one thing that gates whether anyone can log in at all."
It also complicates 003's dual-licensing story for no reason: AGPL's whole
value proposition is that a self-hoster owes us nothing and needs nothing
from us; making sign-in itself depend on an external SaaS account
undercuts that pitch on the very first screen. Clerk's engineering-time
savings (prebuilt `<OrganizationSwitcher>`, hosted sign-in UI) are real,
but they are optimizing the wrong side of the build order — Clerk saves
work on Team-workspace UI (AT4/AT5-shaped work), not on the auth
foundation 001 §4 says has to exist and be genuinely self-hostable first.

### Why not a bundled self-hostable IdP container (option c)

Considered: ship an OIDC provider (Keycloak, Ory Kratos, Zitadel) as a
service in `docker-compose.yml`. Rejected — it solves a problem this
product doesn't have. Those are built for organizations that need to
federate many existing identity sources (LDAP, SAML, multiple OIDC
upstreams) into one broker. Waypoint's actual requirement, restated from
the onboarding spec, is much smaller: two OAuth providers and a magic
link, three ways to prove "this email/account is real," never a password.
That is a well-trodden pattern implemented directly in the app's own
backend (Plane, Cal.com, Grafana, Gitea all do exactly this — none of them
bundle a separate IdP container for it). Adding one here means a second
stateful service, a second thing to configure and keep patched, and a
second admin UI to build (the IdP's own) on top of the one this doc
already has to build (§4). It is more self-hosting friction, not less —
the opposite of what a self-hosted-first product should optimize for.

### What this means concretely

Every OAuth/session/email primitive Clerk would have provided, we own:
authorization-code exchange against GitHub's and Google's OAuth endpoints
(operator supplies `client_id`/`client_secret` per provider, via env —
these are free, self-service app registrations either provider issues in
minutes, not a paid or gated dependency), a magic-link mailer via
operator-supplied SMTP (nodemailer, the standard choice — no existing
mail-sending code in this codebase to react to or extend, so this is a
from-scratch, well-understood addition), and our own session table in the
same Postgres instance everything else already lives in. **Cloud is not a
different implementation of any of this** — it is the exact same code
running with *our* GitHub/Google client IDs and *our* SMTP relay instead
of an operator's, which is precisely 001 §2's framing: "cloud is not a
different codebase... our servers + TLS + billing + the app pointing at
our URL." Auth is no exception to that rule; under the Clerk plan it
quietly would have been (Clerk-hosted sign-in for both cloud *and* every
self-hoster is one shared SaaS dependency, not "the same code, different
operator"). Built-in auth makes auth follow the same one-codebase rule
everything else in 001 already commits to.

## 2. Multi-tenancy shape

One backend instance (process + Postgres), many workspaces. A signed-in
identity resolves through a middleware to a `(user, workspace, member)`
triple; every workspace-scoped route filters by it explicitly, checked
route-by-route, not assumed. This is unchanged in shape from the prior
doc's `req.member` proposal — what changes is what resolves it (§4) and
one real gap the prior doc's schema plan didn't surface (§3).

## 3. Schema

Building on `waypoint-backend/src/db/schema/workspace.ts`
(`workspaces`/`members`, read directly — `planTierEnum`, `memberRoleEnum`,
and `authMethodEnum` already exist and are kept).

### The gap in the prior doc's schema plan, found by tracing it through

The prior doc proposed adding `clerkUserId text unique, nullable` directly
onto the existing `members` row and leaving `members.email` as its current
**globally unique** column. Trace that through the product's own spec:
Jordan (AT4/step 10) signs in once and joins Fairweather Labs; nothing in
the onboarding spec stops Jordan from later being invited to a second,
unrelated team on the same self-hosted instance. That is two `members`
rows for one person, and `members.email unique` — true in the schema
today, unchanged by the prior doc's plan — rejects the second one outright.
This isn't hypothetical: it is the very next thing that happens once a
second workspace exists on one instance, which is exactly what AT4-shaped
work creates. The fix is a real schema decision, not a widened constraint
bolted onto the current table.

### The fix: split identity from workspace membership

- **New `users` table** — one row per real person on this instance,
  independent of any workspace: `id`, `email text unique not null`,
  `authMethod` (reuses `authMethodEnum`), `authProviderId text` (the
  GitHub/Google subject id, or null for email-link-only), `fullName`,
  `avatarUrl`, `isInstanceAdmin boolean not null default false` (§4),
  `createdAt`. This is the row a session token points at.
- **`members` becomes the workspace-membership row it already
  conceptually is** — add `members.userId text references users(id),
  nullable`. Null is Personal's unauthenticated seeded `mem-1` row
  (`db/seed.ts` is unchanged, per the prior doc's §1 — Personal never
  gains a `users` row because it never signs in). Set once a person joins
  a Team workspace or turns on Sync.
- **`members.email unique` relaxes to `unique(workspaceId, email)`** — the
  concrete fix for the gap above. Display fields (`fullName`,
  `displayName`, `avatarColor`) stay on `members`, per-membership, exactly
  as today — every existing query that reads them keeps working unchanged,
  same guarantee the prior doc's plan made, just satisfied by a join
  instead of a shared row.
- **`workspaces.clerkOrgId` is dropped from the plan** (no Clerk
  Organizations exist to mirror); the mode signal the prior doc wanted it
  for — "is this workspace Personal or a real Team" — is carried instead
  by **`workspaces.isPersonal boolean not null default false`**, set
  `true` only on the seeded `ws-1` row. This is more direct than inferring
  the same fact from whether an external org id happens to be null.
- **`workspaces.reviewHistoryDays integer default 30`** — unchanged from
  the prior doc; AT6 (unchanged, out of scope here) enforces it.
- **New `sessions` table** — `id`, `userId references users(id) on delete
  cascade`, `tokenHash text unique not null` (SHA-256 of the opaque
  bearer token; the raw token is never stored, mirroring `jiraAuth.ts`'s
  own don't-store-what-you-don't-have-to discipline for a different
  secret), `createdAt`, `expiresAt`, `lastSeenAt`, `deviceLabel text`
  (what the desktop app's "Devices & Sync" list in Settings, AT6, already
  needs to show). A session belongs to a `user`, not a `member` — the
  same person can hold one session while switching between two workspace
  memberships (the workspace switcher, AT4/step 11), which is the whole
  reason identity and membership had to split in the first place.
- **New `instance_settings` table**, a singleton (`id` fixed to the
  literal `'instance'`) — §4.

### Migration shape

Additive and backfillable without data loss: `users` and `sessions` are
new tables; `members.userId` and `workspaces.isPersonal` are new nullable/
defaulted columns; the `email` constraint change
(`drizzle-orm`'s equivalent of `DROP CONSTRAINT ... UNIQUE; ADD CONSTRAINT
... UNIQUE (workspace_id, email)`) is the only genuinely destructive-looking
line, and it's safe today specifically because exactly one workspace and
one member exist in any current database — the same "latent gap, not yet
exploitable" situation the prior doc found in `listMembers()` (below).

## 4. Instance-level admin — where it lives

Self-hosters need "God Mode" (Plane's term); cloud customers never see it,
because cloud's one instance is ours to operate, not theirs.

- **First-run detection:** an unauthenticated `GET /instance/setup-status`
  returns `{ setupRequired: boolean }` — true iff no `instance_settings`
  row exists yet. The desktop app checks this against whatever backend
  URL it's pointed at (self-hosted or cloud) before showing the normal
  sign-in card; cloud's instance is provisioned by us ahead of any
  customer ever reaching it, so `setupRequired` is always `false` there,
  and the desktop app never renders the setup wizard against our own
  cloud URL. Same code, different data — 001 §2's rule, applied to this
  surface too.
- **The setup wizard** (self-hosted only, shown once): instance name,
  which auth methods are actually usable (computed from which env vars
  the operator actually set — GitHub, Google, SMTP are each independently
  optional, but at least one must be configured or the wizard blocks with
  a clear error rather than producing an instance nobody can sign into),
  and signup mode (`open` — anyone who can reach this instance and
  authenticate can create a workspace — or `invite_only` — only an
  existing member can invite). Submitting it writes the one
  `instance_settings` row and creates the **first** `users` row from
  whichever auth method the operator just completed, with
  `isInstanceAdmin = true`.
- **Ongoing admin surface:** `GET/PATCH /admin/instance`, guarded by
  `req.user.isInstanceAdmin` (§5) — change signup mode, see the instance's
  workspace/user counts. New files: `waypoint-backend/src/routes/
  admin.routes.ts`, `services/instance.service.ts`.
- **Never exposed on cloud:** the admin routes exist in the same codebase
  (001 §2's rule again) but the desktop app only surfaces the admin
  settings page when `req.user.isInstanceAdmin` is true for *that*
  backend, which for our own cloud instance is nobody outside our own ops
  tooling — no separate build flag, just a fact about which `users` row
  cloud onboarding ever sets that bit on (it doesn't).

## 5. Auth mechanism — sign-in flow, token storage

One flow, reused identically for the inviter (mockup step 7), every
invitee (step 9/10), and Settings → Devices & Sync (step 14) — unchanged
intent from the prior doc, different mechanics underneath since there is
no Clerk to delegate the actual provider exchange to.

1. **Main process** (new module, alongside `waypoint-frontend/src/main/
   jira/jiraAuth.ts` in spirit — its own file, its own on-disk blob, same
   reasoning as that module's comment on why Jira and Copilot credentials
   never share a file) starts a one-shot loopback HTTP server on an
   OS-assigned `127.0.0.1` port and generates a `state` value. This part
   is unchanged from the prior doc's plan and is still the mechanism to
   copy from `/Users/amaannawab/emdash/apps/emdash-desktop/src/main/core/
   shared/oauth-flow.ts` — a PKCE loopback flow, not a registered custom
   URL scheme, for the same reasons the prior doc already established.
2. `shell.openExternal()` opens the **backend's own** hosted sign-in page
   (self-hosted: `http://<operator-host>/sign-in?redirect_uri=http://
   127.0.0.1:<port>/callback&for=<workspace-slug|sync>`; cloud:
   `https://accounts.waypoint.sh/sign-in?...`, same query shape) — this
   page is now ours to render (a small server-rendered or static page
   served by `waypoint-backend` itself), not Clerk's.
3. On that page the person picks GitHub, Google, or "email me a link."
   GitHub/Google: the backend runs the standard OAuth authorization-code
   exchange server-side against the operator's configured client
   id/secret, using its own callback endpoint
   (`/auth/{github,google}/callback`) as the provider-facing
   `redirect_uri` (this is the URI actually registered with GitHub/Google
   — stable per instance, not the ephemeral loopback port, which sidesteps
   any "does the provider allow a dynamic redirect URI" question the prior
   doc had flagged as a Clerk-specific risk to verify — it no longer
   applies, because the loopback port is only ever known to our own
   backend, one hop further from the provider than it was under Clerk).
   Email link: the backend emails a one-time, short-TTL signed link
   (stored hashed, like sessions); clicking it hits a backend verify route.
4. Whichever method completed, the backend creates (or reuses, if
   `authProviderId`/email already resolves to an existing `users` row) a
   `users` row, issues an opaque session token, stores only its hash in
   `sessions`, and redirects the browser to the original
   `redirect_uri=http://127.0.0.1:<port>/callback?token=...&state=...`
   (`state` checked against step 1's value before anything else happens).
5. Main receives the raw token over loopback, `safeStorage`-encrypts and
   persists it (mirroring `jiraAuth.ts`'s `writeStoredJiraCredential`
   shape exactly — dedicated file, 0600, hard refusal when
   `safeStorage.isEncryptionAvailable()` is false, no plaintext fallback),
   closes the loopback server, and exposes a renderer-safe "signed in as
   `<name>`" / "signed out" projection over IPC — the same boundary
   `toJiraIdentity()` already draws in that file: **the renderer never
   sees the raw session token**, main attaches it as a Bearer header on
   every request scoped to a Team workspace or Sync.

## 6. `req.member` middleware and the workspace-scoping audit

### The middleware

New Express middleware, **hosted-backend-code-path only** — Personal's
local backend keeps importing the literal `CURRENT_USER_ID`/`WORKSPACE_ID`
constants from `waypoint-backend/src/lib/currentUser.ts` completely
unmodified, exactly as the prior doc specified. On a hosted request: hash
the incoming Bearer token, look it up in `sessions` (reject if missing or
`expiresAt` has passed, refresh `lastSeenAt`), resolve to a `users` row,
then require a `workspaceId` (header or route param, request-shape TBD at
implementation) to resolve the matching `members` row via
`(workspaceId, userId)` — attaches `req.user` (the `users` row) and
`req.member` (the `members` row, carrying `.workspaceId` and `.role`) onto
the request. No custom crypto beyond the SHA-256 hash comparison already
used for `sessions.tokenHash` — this is deliberately simpler than the
prior doc's Clerk-JWT-verification plan, because there is no third-party
signature to verify; the token's validity *is* the database row.

### Every real call site (from the actual grep, re-verified against this
checkout — unchanged from the prior doc's table, since it comes from the
same code, not from the auth provider):

`routes/copilot.routes.ts`, `services/comments.service.ts`,
`services/agentAssignments.service.ts`, `services/members.service.ts`,
`services/scratchNotes.service.ts`, `services/tickets.service.ts` (12+
activity-log `actorId` writes, `@me` resolution), `services/docs.service.ts`,
`services/agents.service.ts`, `services/views.service.ts`,
`services/notifications.service.ts`, `services/projects.service.ts` — each
site's `CURRENT_USER_ID` becomes `req.member.id` on the hosted path.
Renderer-side: `waypoint-frontend/src/renderer/data/currentUser.ts`,
`data/api.ts`, `components/sessions/{BriefPreviewDialog,
NewSessionDialog}.tsx` stop hardcoding `CURRENT_USER_ID = 'mem-1'` on the
hosted/Team path and instead read the signed-in identity §5 exposes over
IPC; Personal is unchanged.

### The confirmed live gap (verified directly, `waypoint-backend/src/
services/members.service.ts` lines 44–46, read above):

```ts
export async function listMembers() {
  return db.select().from(members);
}
```

No `WHERE` clause at all — every `members` row in the entire database,
across every workspace, returned to any caller. Latent only because
exactly one workspace exists today; exploitable the instant a second
workspace exists, which AT12 (§7) creates. Fix, part of this same ticket:
`db.select().from(members).where(eq(members.workspaceId,
req.member.workspaceId))`.

### The scoping audit — concrete route list

Beyond the `CURRENT_USER_ID` sites above, every route reading or writing
workspace-scoped data needs an explicit `req.member.workspaceId` filter,
checked file-by-file, not assumed correct because "there's only one
workspace today":

| File | What to check |
|---|---|
| `services/members.service.ts` | `listMembers()` — confirmed leak above |
| `services/projects.service.ts` | Project listing/lookup scoped to workspace |
| `services/tickets.service.ts` | Ticket listing/search — currently workspace-implicit |
| `services/views.service.ts` | Saved views |
| `routes/workstreams.routes.ts`, `routes/sprints.routes.ts` | Workstream/sprint listing |
| `services/docs.service.ts` | Doc listing/lookup |
| `services/scratchNotes.service.ts` | Filters by `authorId` only today — two members of two different workspaces are currently distinguished by author alone; needs a `workspaceId` filter added, not just relying on author identity |

### The proving test

A new integration test, `waypoint-backend/src/middleware/
workspaceScoping.integration.test.ts`, matching the existing
`*.integration.test.ts` convention (`services/tickets.service.integration.
test.ts` et al.): seed **two** real workspaces (`A`, `B`) each with one
`users`/`members` pair and one ticket, one project, one view, one doc.
Authenticate as workspace `A`'s member (a real session token, not a
mocked `req.member`) and, for every route in the table above, request
workspace `B`'s resources by id — assert a `404`/`403`, never workspace
`B`'s data, and separately assert `GET /members` as `A` never includes
`B`'s member row. This is the test that turns "checked, not assumed" from
a sentence in this doc into something CI enforces; it must fail against
today's `listMembers()` before the fix and pass after, which is the
concrete acceptance bar for closing this gap.

## 7. Invite / join flow

Unchanged in product shape from the prior doc — mockup steps 6–11 — built
on top of §3–§6 instead of Clerk Organizations:

- **Invite modal** (step 6): one field, workspace name → `POST
  /workspaces` creates a `workspaces` row (`isPersonal = false`) and,
  using the already-signed-in `req.user` from §5's flow, a founding
  `members` row with `role = 'admin'`.
- **Invite link** (step 9): `POST /workspaces/:id/invites` creates a
  short-lived invite token (own small table or a signed token — either is
  fine, invite tokens are lower-stakes than session tokens since accepting
  one still requires completing §5's real sign-in); the resulting URL
  (`app.waypoint.sh/join/...` self-hosted equivalent) is what step 9's
  "Copy link" / "Email invite instead" send.
- **Join** (step 10): the invitee hits §5's identical sign-in flow with
  the invite token carried through `state`; on success, the backend
  resolves or creates their `users` row and inserts the `members` row
  scoped to the inviting `workspaceId` — this is precisely the moment
  `members.email` uniqueness had to become `(workspaceId, email)` (§3):
  Jordan's email may already exist on a `users` row from an unrelated
  workspace, and that must be a **reuse of the `users` row**, not a
  collision.
- **Workspace switcher** (step 11): reads every `members` row for
  `req.user.id` and lets the app re-point its `workspaceId` header —
  straightforward once identity and membership are split (§3).
- **Per-member Jira credential storage** on the hosted path: unchanged
  from the prior doc — a Postgres column per `members` row, replacing the
  single-machine `jira-auth.json` for hosted members; `borrowedCredential.
  ts`'s existing per-request-header pattern stays the shape.

## 8. What a self-hoster configures on day one, and what cloud adds

**Self-hoster, day one (all via `docker-compose.yml` env, all optional
individually, at least one auth method required):**

- `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` — a free,
  self-service GitHub OAuth App registration, theirs, five minutes.
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` — same, via
  Google Cloud Console.
- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` —
  their own relay (any provider), for email-link sign-in.
- `INSTANCE_SIGNUP_MODE` default (`open`/`invite_only`) — settable at
  first-run instead if left unset.
- Nothing else. No account with us, no API key from us, no license
  check to defeat (003 §5) — a self-hoster who configures none of the
  above simply can't complete first-run setup, which is an honest failure
  mode, not a crippled product.

**Cloud adds, and only this:** our own GitHub/Google client
credentials, our own SMTP relay, TLS + `accounts.waypoint.sh`/
`app.waypoint.sh` (AT1, unchanged, still out of scope here), and the fact
that our `instance_settings` row is pre-provisioned so `setupRequired` is
always `false` for any customer reaching it (§4) — our own "God Mode"
account is internal ops tooling, never customer-facing. Billing (AT6) is
the other cloud-only layer, already a separate module per 003 §7 and
untouched by this doc.

## 9. What's out of scope, deliberately, and why the design still holds under it

- **Cloud deployment** (TLS, our servers, our hostnames) — existing AT1.
  This doc's auth code is deployment-target-agnostic by construction (§1,
  §8): AT1 is infrastructure work on top of it, not a prerequisite for it,
  and per 001 §4 it now comes **after** this epic, not before.
- **Billing / seat-cap / history enforcement** — existing AT6, a
  separate module per 003 §7. This doc's schema adds `reviewHistoryDays`
  and leaves it unread — the enforcement point stays AT6's, unchanged.
- **The desktop app's first-launch behavior** (001 §3's open fork —
  bundled local DB vs. sign-in-first). Not resolved here, deliberately:
  every mechanism in this doc only activates the moment someone signs in
  for Team or Sync, regardless of what Personal's own first-launch screen
  ends up being. `users`/`sessions` rows are never created for a Personal
  install that never invites anyone, under either version of 001 §3.
- **Discovery UI** (sidebar item, Assignee-field trigger, milestone
  nudge) — existing AT5, unchanged, now depends on this epic's invite
  ticket (§10) instead of the old AT4.

## 10. New epic and sequencing

Continues the flat `AT` lettering as **AT7–AT13** rather than nesting
(e.g. `AT2.1`) — the existing board already reads AT-numbers as flat,
independently-referenceable ticket identifiers (AT1, AT5, AT6 stay exactly
where they are), and reusing `AT2`–`AT4` for different scope after
cancelling the originals would make old references to "AT3" ambiguous in
history/PRs. New tickets, in build order (schema before middleware before
routes; sign-in before invite, matching the audit's own sequencing rule):

- **AT7** — Schema: `users`, `sessions`, `instance_settings`;
  `members.userId`, `workspaces.isPersonal`, `workspaces.
  reviewHistoryDays`; `members.email` uniqueness scoped to workspace.
- **AT8** — Instance first-run setup + instance admin ("God Mode").
- **AT9** — Backend auth: GitHub/Google OAuth exchange, SMTP magic link,
  session issuance — the reusable server-side primitive.
- **AT10** — Desktop loopback-callback sign-in client (main-process
  module, `safeStorage` token persistence, signed-in IPC projection, the
  waiting-card UI).
- **AT11** — `req.member` middleware + full workspace-scoping audit +
  the `listMembers()` fix + the proving test.
- **AT12** — Team workspace creation + invite + join flow, end to end,
  including per-member Jira credential storage.
- **AT13** — Self-hosted operator packaging: `docker-compose.yml` env
  wiring for OAuth/SMTP/signup-mode, operator-facing setup docs — the
  ticket that makes "Team self-hosting is available today" an honest claim
  by the end of this epic, rather than a deferred follow-up.

Existing tickets this reconciles with (§11 of the PR/handoff, not
repeated here): AT1 now follows AT7–AT13 per 001 §4; AT2/AT3/AT4 are
cancelled, absorbed into AT9+AT10 / AT11 / AT12 respectively; AT5 depends
on AT12 instead of the old AT4; AT6 depends on AT10 (sign-in reuse) and
AT7 (schema) instead of the old AT2/AT3.
