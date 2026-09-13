# Accounts and teams · one launch, two modes

Status: design doc, written before the code. No branch/PR yet — Personal
and Team ship together at the Product Hunt launch, not phased. Companion:
`waypoint-product-strategy.md`; supersedes the "not a standalone
Jira/Linear replacement" framing there — Team mode is exactly that
replacement, for whoever wants it, from day one.

## 0. Why

Waypoint runs single-user-per-install today: one Electron app, one local
Postgres, one hardcoded member row (`CURRENT_USER_ID = 'mem-1'`,
`lib/currentUser.ts`), no session, no login, `app.ts`'s own comment says
it plainly — *"this process has no auth — there's still none in this
phase."* That was fine while the product was one founder's own dev
loop. Launch changes it in two ways at once:

- **Personal**: a download-and-run app with no account has no licensing
  story and no identity for anything the app ever says on your behalf (a
  Jira comment posted "as mem-1").
- **Team**: some fraction of launch-day visitors aren't evaluating this
  solo — they want to invite the two people they work with immediately.
  If that only works by self-hosting a Docker Compose stack, that
  fraction bounces at the exact moment they'd have converted. Waypoint's
  own tickets/sprints/comments (not just Jira-sync) only work as a team's
  shared board if there's one shared source of truth, which a local
  Postgres per laptop can never be.

The schema already half-expects both: `workspaces` (`plan`, `slug`,
`restrictWorkspaceCreation`), `members.role` (`admin|member|guest`),
`members.authMethod` (`email|google|github|gitlab|gitea`) — genuine
multi-tenant SaaS modeling, entirely unenforced. Someone building this
earlier planned for exactly this fork. This doc finishes activating it,
once, for both.

## 1. The two modes, both live at launch

| | Personal | Team |
|---|---|---|
| Who | one person | a team, invited in |
| Source of truth for tickets | Jira (or none, if only using My sessions) | Waypoint's own Postgres |
| Backend | Waypoint-hosted, one workspace per account | Waypoint-hosted, one workspace per team |
| Multi-tenancy | technically real, practically a no-op (one member) | real — `workspaces`/`members`/`role` enforced |
| Jira credential | per member, from day one | per member, same mechanism |

They are not two builds — they're the same account/workspace machinery
with the fork happening once, right after sign-in ("Just for me" vs.
"Set up my team"). Treating a solo account as "a team of one" from the
start (not a special case) is what makes Team additive later instead of
a rework: workspace-scoping, `req.member` resolution, and per-member
Jira credentials are built once, correctly, and Personal is just the
one-member instance of the same thing.

## 2. Hosting: Waypoint runs the shared backend

This is the real decision this doc is making, stated plainly: **for Team
mode to be zero-friction at launch, Waypoint hosts a shared multi-tenant
Postgres + API.** Not every team spinning up their own — that's a later,
optional path (`docker-compose.yml` already exists and keeps working for
whoever wants to self-host, an enterprise/advanced option, not the
default). Personal-mode accounts can live on the same hosted backend as
a single-member workspace, or stay fully local depending on what's
decided for the free tier — that choice affects infra cost per free user
and is worth its own line item, not assumed here.

Concretely: the backend gains real network exposure for the first time
(`index.ts`'s `127.0.0.1` default was correct when there was no auth; it
stops being the right default once Clerk sessions are the actual
boundary) — TLS termination, a real deployment target (a small managed
Postgres, a container host), and the ops burden that comes with running
a service other people depend on. That's a genuine cost to weigh against
the conversion benefit, not a footnote.

## 3. Provider: Clerk

**Clerk**, not a hand-built `auth.emdash.sh`-style service (real infra
investment, wrong place to spend pre-launch runway) and not WorkOS
(better at enterprise SSO, worse at the fast prosumer-developer signup a
Product Hunt audience needs on day one).

Why, in order:

1. **Organizations are a native primitive**, not bolted on — and now
   load-bearing, not a nice-to-have: Team mode's `workspaces`/`members`/
   `role` map onto Clerk Organizations and Organization Memberships
   directly, and Clerk ships the invite/create/switch UI for them —
   real engineering time saved on exactly the surface a launch needs
   fastest.
2. Prebuilt sign-in/sign-up/organization components — real time saved
   in the days before a launch.
3. Generous free tier; this is a pre-revenue launch.
4. A later enterprise deal needing real SSO (SAML, Okta, Entra) is a
   bounded migration — it swaps the session-verification boundary, not
   the app.

## 4. What changes in the schema (activate, don't redesign)

- `members` gains `clerkUserId text unique` — the join key. `email`/
  `fullName`/`displayName`/`avatarColor` become synced-from-Clerk fields
  rather than backend-owned, but stay columns here (every existing query
  joining on `members` keeps working unmodified).
- No password/session table in Waypoint's own Postgres — Clerk owns
  credentials and session validity. The backend's job: given a Clerk
  session token on a request, resolve it to a `members` row (or reject).
- `workspaces` gains `clerkOrgId text unique, nullable` — null for a
  solo Personal workspace, set for a Team workspace mapping to a real
  Clerk Organization.
- Jira credential storage moves from `jira-auth.json` (one file, one
  machine) to a Postgres column per `members` row, encrypted at rest —
  needed for Team from day one, and free for Personal since it's the
  same code path with one row. `borrowedCredential.ts`'s per-request-
  header pattern (already built for W5b) is exactly the right shape to
  keep; it starts reading the *calling member's* stored credential
  instead of the one machine-local file.

## 5. The build

**Backend**

- `req.member` middleware resolving a Clerk session token to a `members`
  row (Clerk's Node SDK verifies it — no custom crypto). Replaces
  `CURRENT_USER_ID` at its three call sites in `members.service.ts`.
- Every route that reads/writes workspace-scoped data filters by
  `req.member.workspaceId` — audited, not assumed. This is where a
  multi-tenant bug bites: one workspace's data leaking into another's
  list. Doing it correctly for Team also means Personal is correct by
  construction, not a special-cased single-tenant path.
- First sign-in: the fork. "Just for me" creates a solo workspace and
  one `members` row from the Clerk profile. "Set up my team" creates a
  Clerk Organization, a `workspaces` row with `clerkOrgId` set, and the
  founding member's row. Either way replaces `db/seed.ts`'s hardcoded
  insert — its job shrinks to migrations only.
- Invites: Clerk's Organization invite flow; an accepted invite creates
  the matching `members` row scoped to that `workspaceId`.
- `members.role` (`admin|member|guest`) enforced for the first time —
  PM mode's "see every ticket in the workspace" is a natural
  `admin`-tier capability, worth deciding explicitly.
- `plan` read for gating — what's actually gated (a session-count cap, a
  feature flag, nothing at all for v1) is a product call to make before
  this part, not an engineering one.

**Desktop app**

- A sign-in screen before the app's normal UI mounts — system-browser
  OAuth-style flow (not an embedded webview, matching how emdash's own
  `account` slice does it), landing back via a custom protocol handler.
- Right after sign-in, the fork UI: "Just for me" / "Set up my team".
- A workspace switcher in the app chrome (Clerk's `OrganizationSwitcher`,
  restyled) for anyone in more than one workspace.
- The session token stored via `safeStorage`, beside `jiraAuth.ts`'s
  existing pattern — revalidated on launch the same way. The renderer
  never sees the token; main holds it and attaches it to backend
  requests, the renderer only ever sees "signed in as \<name\>" or
  "signed out."
- The backend's URL becomes real desktop-app config (the hosted
  endpoint by default; a self-hosted URL as the advanced override) —
  no longer an assumed `localhost:14000`.

## 6. Open question, deliberately unresolved here

Does a solo workspace's data "become" a team's data if its owner later
invites people in, or does inviting someone always start a distinct team
workspace, with the solo one staying personal? Two honest options — no
migration needed before this ships either way, since both are "create a
new workspace, don't touch the old one" at the data layer. Worth a
product decision, not an engineering one.

## 7. Sequencing

1. Clerk integration: sign-in, the solo/team fork, `req.member`
   middleware, workspace-scoping audit, onboarding replacing the seed.
2. Per-member Jira credential storage (replaces `jira-auth.json`).
3. Invite flow, `OrganizationSwitcher`, `role` enforcement.
4. Plan gating, once what's actually gated is decided.
5. Hosting: stand up the shared backend deployment itself — this has to
   land before step 1 ships to real users, sequenced last here only
   because it's infra work that can start in parallel with 1–3, not
   because it's optional.

## 8. What decides whether this was right

A downloaded build signs in and chooses solo or team in under a minute.
A solo account's every Jira write and every proposal disclosure says a
real name instead of a seeded one. A team's invite works end to end —
two different people's machines, signed into the same workspace, seeing
the same ticket list and Review queue, with no data crossing into a
workspace that didn't invite them.
