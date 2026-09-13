# Accounts and teams · personal launch, team product, one foundation

Status: design doc, written before the code. No branch/PR yet — this
covers two initiatives, Personal (build now, targets the Product Hunt
launch) and Team (design now, build when a team asks for it). Companion:
`waypoint-product-strategy.md`; supersedes the "not a standalone
Jira/Linear replacement" framing there — Team mode is exactly that
replacement, for a team that wants it.

## 0. Why

Waypoint runs single-user-per-install today: one Electron app, one local
Postgres, one hardcoded member row (`CURRENT_USER_ID = 'mem-1'`,
`lib/currentUser.ts`), no session, no login, `app.ts`'s own comment says
it plainly — *"this process has no auth — there's still none in this
phase."* That was fine while the product was one founder's own dev
loop. It stops being fine at two separate moments, for two different
reasons:

- **Personal**, at Product Hunt launch: a download-and-run app with no
  account has no licensing story and no identity for anything the app
  ever says on your behalf (a Jira comment posted "as mem-1").
- **Team**, whenever the first team asks to run Waypoint's own tickets,
  sprints and comments as their actual board rather than a Jira mirror:
  Waypoint's local Postgres has to become the shared source of truth,
  and two people each running their own laptop's Postgres will never see
  each other's data. Jira-sync mode doesn't have this problem — Jira
  itself is the shared source of truth there — but the native ticket
  system that already exists in this codebase (projects, sprints,
  workstreams, tickets, comments) does.

The schema already half-expects both: `workspaces` (`plan`, `slug`,
`restrictWorkspaceCreation`), `members.role` (`admin|member|guest`),
`members.authMethod` (`email|google|github|gitlab|gitea`) — genuine
multi-tenant SaaS modeling, entirely unenforced. Someone building this
earlier planned for exactly this fork and left it half-built. This doc
finishes it, in two phases that share one foundation instead of two
unrelated builds.

## 1. The two modes

| | Personal | Team |
|---|---|---|
| Who | one person, one laptop | a team, one shared backend |
| Source of truth for tickets | Jira (or none, if they only use My sessions) | Waypoint's own Postgres |
| Backend | local, `127.0.0.1:14000`, as today | one shared instance every member's app points at |
| Why an account exists | licensing, identity for writes | real per-person access to shared data |
| Multi-tenancy | none — always one workspace, one member | real — `workspaces`/`members`/`role` enforced |
| Ships | at launch | when a team asks for it |

Personal is not a stepping stone to Team and Team is not Personal-plus-
more-people — they're genuinely different deployment shapes. What they
share is the *account* layer: the same sign-in, the same provider, the
same session-token pattern in the desktop app. Get that shared layer
right once and Team is additive later — a deployment config and an
invite flow, not a rebuild.

## 2. Provider: Clerk

Recommendation, not a menu: **Clerk**, not a hand-built
`auth.emdash.sh`-style service (real infra investment, wrong place to
spend pre-launch runway) and not WorkOS (better at enterprise SSO, worse
at the fast prosumer-developer signup a Product Hunt audience needs on
day one).

Why Clerk specifically, in order:

1. **Organizations are a native primitive**, not bolted on — Team mode's
   `workspaces`/`members`/`role` map onto Clerk Organizations and
   Organization Memberships directly. Nothing about building Personal
   first forecloses Team later.
2. Prebuilt, good-looking sign-in/sign-up components — real time saved
   on exactly the days before a launch where UI polish matters most and
   engineering time is shortest.
3. Generous free tier; this is a pre-revenue launch.
4. If a later enterprise deal needs real SSO (SAML, Okta, Entra) that
   Clerk doesn't cover as well, that migration is bounded — it swaps the
   session-verification boundary (one middleware file, main-process
   token handling), not the app.

## 3. What changes in the schema (activate, don't redesign)

- `members` gains `clerkUserId text unique` — the join key. Nothing else
  about the table's shape needs to change; `email`/`fullName`/
  `displayName`/`avatarColor` become synced-from-Clerk fields rather
  than backend-owned, but stay columns here (every existing query that
  joins on `members` keeps working unmodified).
- No password/session table in Waypoint's own Postgres — Clerk owns
  credentials and session validity entirely. The backend's job is: given
  a Clerk session token on a request, resolve it to a `members` row (or
  reject).
- `workspaces` needs a `clerkOrgId text unique, nullable` — null for
  every Personal-mode workspace (there's exactly one, seeded once per
  install, same as today); set for a Team-mode workspace, mapping to a
  real Clerk Organization.

## 4. Personal — build now

**Backend**

- New middleware resolving `req.member` from a Clerk session token
  (Clerk's Node SDK verifies it — no custom crypto). Replaces
  `CURRENT_USER_ID` at its three call sites in `members.service.ts`.
- First request from a never-before-seen Clerk user: create the
  workspace's one `members` row from the Clerk profile (name, email,
  avatar) instead of `db/seed.ts`'s hardcoded insert. The seed script's
  job shrinks to "create the empty `workspaces` row," nothing member-
  shaped.
- A `plan` read on the member/workspace for gating — what's actually
  gated (a session-count cap, a feature flag, nothing at all for v1) is
  a product call to make before building this part, not an engineering
  one.

**Desktop app**

- A sign-in screen before the app's normal UI mounts — Clerk's Electron
  guidance is a system browser OAuth-style flow (not an embedded
  webview: matches how emdash's own `account` slice and most desktop
  apps with a hosted account do it) landing back in the app via a custom
  protocol handler.
- The session token stored via `safeStorage`, right beside
  `jira-auth.json`'s existing pattern (`waypoint-frontend/src/main/jira/
  jiraAuth.ts` is the template to copy, not reinvent).
  Revalidated on launch the same way `jiraAuth.ts` already checks
  connection health.
- **The renderer never sees the token** — same rule as every credential
  in this codebase. Main holds it, main attaches it to backend requests,
  the renderer only ever sees "signed in as \<name\>" or "signed out."

**What does not change:** the backend stays bound to `127.0.0.1`
(`index.ts`'s existing default), local Postgres, one workspace, one
member. Personal mode's account is about identity and licensing, not
about serving more than one person.

## 5. Team — designed now, built on demand

Not part of this build. Laid out here so Personal doesn't have to be
undone to get here.

- **Deployment.** The existing `docker-compose.yml` already stands up
  Postgres + the API as one unit (`HOST=0.0.0.0` inside the container,
  published only to `127.0.0.1` on the host — see its own comments). A
  team running Team mode self-hosted runs that compose file somewhere
  reachable on their network (or a small managed Postgres + a container
  host), and every member's desktop app is pointed at that URL instead
  of `localhost:14000` — one new setting in the app, not new
  infrastructure. A Waypoint-hosted option (multi-tenant backend
  Waypoint itself runs) is a later, separate decision — the self-hosted
  path should work regardless of whether that ever ships.
- **Membership.** "Invite your team" creates a Clerk Organization (if
  one doesn't exist for that workspace yet) and a matching
  `workspaces.clerkOrgId`; each invite accepted creates a `members` row
  scoped to that `workspaceId`, same table, same shape as Personal — the
  only difference is there's more than one row and `clerkOrgId` is set.
- **Authorization.** `req.member` resolution is unchanged from
  Personal — what's new is every route needs to actually filter by
  `workspaceId` (the FK exists on `members`, `projects`, and others
  already; whether every read/write route enforces it needs a real
  audit, not an assumption — this is where a multi-tenant bug would
  bite: one workspace's data leaking into another's list).
  `members.role` (`admin|member|guest`) gets enforced for the first
  time — PM mode's "see every ticket in the workspace" is a natural
  `admin`-tier capability, worth deciding explicitly rather than
  defaulting silently.
- **Jira.** `jira-auth.json` (one file, one machine) doesn't work once
  more than one person needs their own Jira identity on the same shared
  board. Moves server-side: a credential per `members` row, `safeStorage`
  becomes a Postgres column encrypted at rest, `borrowedCredential.ts`'s
  per-request-header pattern (already built for W5b) is exactly the
  right shape to keep — it just starts reading the *calling member's*
  stored credential instead of the one machine-local file.

## 6. Open question, deliberately unresolved here

Does a Personal-mode user's local data (their own tickets, their own
session history) ever "become" a Team workspace's data if they later
invite people in? Two honest options — start fresh with an empty Team
workspace and leave Personal data as a personal archive, or build a
real import — and neither needs deciding before Personal ships. Flagging
it now so Team's design doesn't get written twice.

## 7. Sequencing

1. Personal: Clerk integration, `req.member` middleware, onboarding
   replacing the seed, desktop sign-in screen, token storage.
2. Plan gating, once what's actually gated is decided.
3. Team, when the first real team asks: deployment config in the
   desktop app, invite flow, workspace-scoping audit, `role`
   enforcement, per-member Jira credentials.

## 8. What decides whether this was right

Personal: a downloaded build signs in, every Jira write and every proposal
disclosure says a real name instead of a seeded one, and nothing about
local-only Jira-sync mode got slower or more complicated to reach that.
Team: a self-hosted compose deployment, pointed at by two different
machines, shows both people the same ticket list and Review queue with
no data crossing into a workspace that didn't invite them.
