# Accounts and onboarding — comparative research, not a single opinion

Status: research written for a launch decision, not a design doc. Companion
to `docs/design/waypoint-accounts-and-teams.md` (the existing Clerk/hosted
proposal — evaluated here as Approach B, not treated as settled) and
`docs/design/waypoint-product-strategy.md` (the "no server, no vendor"
positioning this doc keeps testing every approach against). Written
2026-09-13. Nothing here is committed, pushed, or filed as a ticket.

## 0. What I actually checked before writing this

Every claim below about the current codebase is read from the source, not
assumed:

- `waypoint-backend/src/lib/currentUser.ts` — `CURRENT_USER_ID = 'mem-1'`,
  `WORKSPACE_ID = 'ws-1'`, hardcoded, matching `db/seed.ts`'s single seeded
  row.
- `CURRENT_USER_ID` is imported in **15 service/route files**, not the
  "three call sites" the existing design doc calls out in
  `members.service.ts` (accurate for that one file, but it undersells the
  surface: `tickets.service.ts`, `comments.service.ts`,
  `notifications.service.ts`, `docs.service.ts`, `scratchNotes.service.ts`,
  `views.service.ts`, `agents.service.ts`, `agentAssignments.service.ts`,
  `projects.service.ts`, and `copilot.routes.ts` all read or write it.
- Of 40 files under `waypoint-backend/src/services/`, only **8 reference
  `workspaceId` at all today**. The other 32 have no workspace filter to
  audit yet — they don't filter incorrectly, they don't filter.
- `waypoint-backend/src/app.ts` / `src/index.ts` — CORS-restricted, not
  authenticated; binds `127.0.0.1` by default, and the code comments say
  plainly why: "this process has no auth."
- `waypoint-backend/docker-compose.yml` — a working, self-hostable
  Postgres + API unit already exists.
- `waypoint-frontend/src/main/jira/jiraAuth.ts` — a Jira API-token
  credential, per machine, encrypted with Electron `safeStorage`, no OAuth
  app registration required. Comment in the file states directly why this
  lives in the Electron main process and not the backend: the backend "has
  no authentication boundary," so a live Jira credential held there would
  sit on a local port anything else on the machine could reach.
- `waypoint-frontend/src/main/jira/jiraClient.ts` — confirmed: every Jira
  API call authenticates with HTTP Basic `email:apiToken`, "Atlassian's own
  documented mechanism for a personal API token." This matters more than it
  looks like it should — see §1.
- `docs/design/w5b-jira-dispatch.md` — confirms the write path end to end:
  "Nothing a session produces reaches Jira except as a proposal a person
  approves... The credential stays in main; the backend borrows it per
  request... the agent never sees it."
- `/Users/amaannawab/emdash/apps/emdash-desktop/src/core/features/account/`
  — read `node/config.ts`, `node/services/emdash-account-service.ts`,
  `api/contract.ts`, `provider-token-dispatcher.ts`, and the two UI call
  sites (`AccountTab.tsx`, `github-connect-modal.tsx`). Grepped the whole
  app for `stripe`, `paywall`, `subscription`, `licens` — **zero hits tied
  to the account service.** What emdash's hosted account actually does is
  narrower than the existing design doc's use of "emdash-style" implies —
  see §1.

## 1. The real fork, sharpened

**Persona 1 — Personal.** One person, their own Jira (or none, if they only
use My sessions locally), no teammates inside Waypoint. They want an
AI-assisted desktop companion for their own ticket work.

**Persona 2 — Team.** A team adopting Waypoint's own native tracker —
tickets, sprints, comments, a shared board — as the thing itself, not a
Jira wrapper. This is the part of the product that structurally requires
more than one laptop to agree on the same data.

These are not as separate as the framing suggests, in one specific,
important way, and conflated in another.

### Where they're less separate than they look: Personal's Jira-sync case needs zero hosted Waypoint infrastructure, today, already

Walk the actual write path. A person connects Jira through `jiraAuth.ts` —
a credential encrypted with `safeStorage`, one file, one machine, no
Waypoint server involved in making that connection. When Copilot proposes
and a person approves a Jira comment or transition, the backend borrows
that credential for one request and calls Jira directly over HTTP Basic
auth with the person's own `email:apiToken` pair. **Jira itself attributes
that write to the real Atlassian account** — not to Waypoint, not to
`mem-1`, not to anything Waypoint's own `members` table says. Two different
people, each running their own local Waypoint install against the same
real Jira project, each with their own Jira credential, already see and act
on the same board today, with zero shared Waypoint infrastructure between
them. That's not a proposal — it's what the current architecture already
does, verified in `jiraClient.ts` and `w5b-jira-dispatch.md`.

This directly narrows a premise in the existing design doc. Its §0 opening
argument for why Personal needs accounts says: *"a download-and-run app
with no account has no licensing story and no identity for anything the
app ever says on your behalf (a Jira comment posted 'as mem-1')."* The
licensing half is a real, separate question (see Approach A). The identity
half is wrong for the Jira-sync case specifically: Jira comments are never
posted "as mem-1" — they're posted as whatever Atlassian account owns the
API token, which Jira resolves independent of anything Waypoint's own
`members` table says. `mem-1` only leaks into anything a person outside
Waypoint sees if it somehow reached Jira, and it doesn't — it stays local,
in Waypoint's own `actorId`/`authorId` columns, used for Waypoint's own
activity log and Waypoint's own comments. Which is exactly Persona 2's
territory.

### Where they're less separate in the other direction: identity only matters once there's a shared thing to attribute it on

`mem-1` is a real problem — but only once more than one person is looking
at the same Waypoint-native data and needs to tell each other apart:
`comments.service.ts`'s `authorId`, `notifications.service.ts`'s
`recipientId`, `docs.service.ts`'s `ownerId`, `tickets.service.ts`'s
`actorId` on every activity-log row. A solo Personal user staring at their
own comments authored by their own single `mem-1` row has nothing to
disambiguate — there's only one person who could have written it. The
identity problem is real, but it's a **Team-mode problem**, triggered by
the moment a second person needs to see whose comment is whose, not a
Personal-mode one.

Net: **the schema's own multi-tenant modeling (`workspaces`, `members.role`,
`members.authMethod`) is preparation for Persona 2, and Persona 1 barely
touches it.** A launch plan that makes every Personal visitor pass through
the same hosted-account machinery Team mode genuinely needs is solving a
problem Persona 1 doesn't have, using the infrastructure Persona 2 does.

## 2. Four approaches, compared honestly

### Approach A — emdash-style: a lightweight hosted account for identity/licensing only, Personal fully local, Team not at launch

**What "emdash-style" actually is**, confirmed by reading the code rather
than assuming from the name: emdash's `auth.emdash.sh` account is an OAuth
*broker*, not an identity platform. Its only real job (per
`provider-token-dispatcher.ts` and `github-connect-modal.tsx`) is standing
in for the OAuth client secret an Electron app cannot safely embed, so a
user can connect GitHub through a real system-browser OAuth flow instead of
pasting a personal access token. `hasAccount`/`isSignedIn` are tracked
separately, sign-in is fully optional, and grepping the whole app for
`stripe`/`paywall`/`subscription`/`licens` turns up nothing tied to it —
every core emdash feature (tasks, projects, worktrees) works with zero
account, signed in or not. It exists to solve one narrow structural
problem, not to gate the product.

**What gets built for launch:** the same shape, ported. One small hosted
service (or none — see the note below), PKCE + system-browser OAuth +
custom protocol handler (`app://waypoint`-style, already registered per
`app.ts`'s CORS comment), session token in `safeStorage` beside
`jiraAuth.ts`'s existing pattern. Its job: a real name and avatar on the
local `mem-1` row, replacing the literal — and, if the founder wants a
licensing story later, a hook to attach one. Team mode ships via
`docker-compose.yml`, already working, relabeled "self-host Waypoint for
your team" — an advanced/rough option, not a polished invite flow.

**Deferred:** invite UI, `OrganizationSwitcher`, `role` enforcement, hosted
multi-tenant Postgres, any workspace-scoping audit at all (there's still
only ever one tenant per deployment).

**Infra/ops cost:** smallest of the four. Either a single small stateless
broker with no persistent multi-tenant data to leak between tenants
(because there are no tenants), or literally nothing if Personal ships
signed-out-by-default with no hosted piece at all.

**Engineering time to launch-ready:** smallest of the four — days, mostly
copying a pattern that's already shipped and tested in emdash.

**Specific risk:** this is the one place the founder's stated goal — *both
personas served on day one* — isn't actually met. "Invite my two
teammates" for a Product Hunt visitor means "ask one of them to stand up
Docker Compose and share a URL," which is real, launch-day-costly friction
for exactly the persona the founder doesn't want to lose. This is a
legitimate approach only if the founder is willing to explicitly accept
that Team-mode conversions on launch day are sacrificed for speed —
worth surfacing as a real, cheaper fallback if the other approaches can't
land in time, not as the primary recommendation.

### Approach B — full multi-tenant from day one (the existing design doc's approach)

This is `docs/design/waypoint-accounts-and-teams.md` as written: Clerk +
Organizations, a hosted multi-tenant Postgres + API, `req.member`
middleware, a workspace-scoping audit, per-member Jira credentials moved
server-side, invite flow, `OrganizationSwitcher`, and — this is the part
that matters most — **a sign-in screen before the app's normal UI mounts,
for every visitor, Personal or Team**, forking into "Just for me" / "Set up
my team" right after.

**What gets built for launch:** everything in that doc's §5: Clerk
integration, the fork UI, workspace-scoping enforcement everywhere,
per-member encrypted Jira credential storage (replacing the already-shipped
`jiraAuth.ts`), invites, role enforcement, and standing up the hosted
deployment itself.

**Deferred:** enterprise SSO (a bounded later migration per the doc), the
specifics of what `plan` actually gates.

**Infra/ops cost:** real and ongoing from day one, for every user including
solo ones — TLS-terminated public endpoint, managed Postgres, a container
host, on-call. The doc's own §2 flags "Personal-mode accounts can live on
the same hosted backend or stay fully local... worth its own line item, not
assumed here" — but then its §5 desktop build item ("a sign-in screen
before the app's normal UI mounts") makes the hosted auth server a hard
dependency for literally opening the app, for everyone, regardless of how
that unresolved line item gets answered. The doc hedges a decision its own
sequencing has already made.

**Engineering time to launch-ready:** largest of the four, and larger than
the doc's own §5 conveys. Its estimate reads as a short list of bullets;
the codebase check in §0 shows the "workspace-scoping audit" bullet alone
covers 32 of 40 service files with zero workspace filtering today, the
`CURRENT_USER_ID` replacement touches 15 files rather than the "three call
sites" the doc names (true only within `members.service.ts`), and the
per-member Jira credential store is a rebuild of a mechanism
(`jiraAuth.ts` + the W5b credential-borrowing path) that is already
shipped, already tested, and — per §1 above — doesn't actually need to
move for Personal mode to work correctly.

**Specific risk:** this is the sharpest one. `waypoint-product-strategy.md`
— the companion strategy doc, in this same repo — names "no Waypoint
server... no per-seat AI tax, because there is no seat and no vendor" as
the one structural claim competitors are "architecturally prevented from
making," and separately flags "no-account, works-on-a-plane is incompatible
with a cloud backend... the real one [objection]." Approach B's mandatory
pre-mount sign-in screen is precisely that incompatibility, shipped, for
the exact audience the strategy doc says the differentiation matters most
to. A solo Jira-only visitor — whose entire workflow needs zero
Waypoint-hosted infrastructure, per §1 — is made to depend on the uptime
of a Waypoint auth server just to open the app.

### Approach C — hybrid: Personal fully local with zero hosted account, Team hosted and real, the fork happens somewhere other than "right after sign-in" — because there is no Personal sign-in

**What gets built for launch:** the app boots straight into use. First run
seeds a local member row from a name the person types once — no account, no
server, no OAuth. This *is* Personal; it isn't a mode chosen from a menu,
it's just what the app is until something requires more. Jira connects
exactly as it does today, unchanged. The fork isn't a screen after sign-in
— it's a specific, deliberate action: **"Create a shared team workspace"**
(or "Join a team workspace" for an invitee). That action is the first and
only point real hosted infrastructure enters the picture — a hosted
multi-tenant Postgres + API, and an auth provider (Clerk or WorkOS — see
§3) for exactly the members of that team, invited in. Someone who never
touches that action never talks to a Waypoint server, ever.

**Deferred:** nothing structurally — Team mode gets the same real
multi-tenant treatment as Approach B (invite flow, role enforcement,
workspace-scoped queries). What's deferred is *forcing it in front of
Personal users*.

**Infra/ops cost:** zero until the first team workspace is created, then
identical to B's ongoing cost per active team — a materially better cost
curve for a pre-revenue launch, since cost scales with actual team-mode
adoption rather than with every download.

**Engineering time to launch-ready:** between A and B. Personal needs
almost no new code (replace the `mem-1` literal with a locally-created
member row and a one-time name field — a smaller change than either A's
OAuth broker or B's full sign-in gate). Team gets the full B-shaped build,
but the workspace-scoping audit only has to be airtight for the code paths
Team mode actually exercises — the native-tracker tables
(`tickets`/`comments`/`notifications`/`docs`/`scratchNotes`) — not the
Jira-sync tables, which per §1 don't need a Waypoint-level tenant boundary
at all (each install's Jira credential is already scoped by the machine).
That's a real, quantifiable reduction in audit surface versus B doing the
same work for every table regardless of whether Jira-sync or native-tracker
data flows through it.

**Specific risk:** Team's "create/join a workspace" moment is still a real
account system with all of B's actual engineering risk — this hybrid
doesn't make that work smaller, only defers *when* a user pays the cost of
hitting it and confines its blast radius. It also means maintaining two
visibly different app shells (a Personal one, a Team-workspace one) as a
real, ongoing product-design cost, and it inherits the existing design
doc's own open question in its §6 unchanged: does a solo user's data
"become" a team's when they invite someone, or does inviting always start a
distinct team workspace? Both remain valid answers here too — this
approach doesn't resolve it, it just doesn't need to resolve it before
launch, since "create a new workspace, don't touch the old one" needs no
migration either way.

### Approach D — a local-first sync engine (ElectricSQL/Replicache-style) as the middle ground for Team mode

Named because the founder asked for it to be genuinely checked, and it is a
real pattern — but the research doesn't support it for a launch, for
specific, concrete reasons rather than a reflexive "too fancy."

**What it is:** ElectricSQL puts a sync layer in front of Postgres and
replicates into a client-side embedded store (PGLite) using CRDTs, so
concurrent edits from multiple clients merge without conflicts and clients
work fully offline. Replicache does something similar with an
operation-based sync model instead of state-based. Both are real,
maintained, documented projects, not vaporware.

**Why it doesn't fit here:** it solves a problem Team mode doesn't have
evidence of yet — offline-tolerant, low-latency, conflict-free editing
across intermittently-connected clients on the *same* rows. Team mode's
actual shape at launch is a handful of people editing a shared board while
online, which a plain hosted Postgres + API with straightforward
last-write-wins semantics already handles, using infrastructure that's
already 80% built (`docker-compose.yml`, the existing Drizzle schema, the
existing services). Critically, ElectricSQL/Replicache don't remove the
need to operate a central Postgres or a multi-tenant auth boundary — they
change *how* clients replicate data, not *whether* Waypoint runs shared
infrastructure. Relative to B or C's Team-mode cost, this **adds**
engineering (a new sync layer, a new client-side store, real
conflict-resolution logic to reason about and test) without removing any
of the ops burden those approaches already carry.

The closest real precedent for the UX this buys — Linear's own sync engine
— is a bespoke, multi-year investment by a team that made it their central
bet from day one. ElectricSQL and Replicache are lighter than building
that from scratch, but "lighter than Linear's" is still a meaningfully
larger and riskier bet than a CRUD API for a v1 that doesn't yet know if
anyone wants offline Team-mode collaboration at all.

**Verdict:** genuinely reject for launch, not defer-and-forget — revisit
specifically if Team mode ships (under B or C), gets real users, and those
users complain about latency or conflicts specifically. Building this
pre-PMF is the same mistake as building the full B stack pre-PMF, one
layer deeper.

## 3. Recommendation

**Approach C — hybrid, with no Personal sign-in.** Stated plainly, this is
what I'd build, and it's the one that treats "launch-ready without
over-building" as the actual constraint rather than a phrase:

- It gets Personal to genuinely zero friction, matching what the codebase
  already proves works today (§1) and matching the exact differentiation
  claim `waypoint-product-strategy.md` already stakes the product on — "no
  Waypoint server, no vendor" stays literally true for the persona it's
  aimed at, instead of becoming marketing copy contradicted by a sign-in
  screen on first launch.
- It confines the genuinely large "real multi-tenant SaaS" engineering lift
  — which is large, confirmed in §0 and §2, not hand-waved — to the moment
  it's actually needed, which also caps ops cost pre-revenue to exactly the
  users generating it.
- It still delivers a real Team mode at launch, unlike A — the founder's
  stated requirement that both personas be served on day one is met, not
  quietly dropped for schedule reasons.

**Tradeoffs I'm accepting by recommending this, named explicitly:**

- Two onboarding flows to design and maintain, not one — a real, ongoing
  product-design cost, not just an engineering one.
- The open question from the existing design doc's §6 (does inviting
  someone convert a solo workspace, or always start a new one?) stays
  genuinely open — this approach doesn't need it answered before launch,
  but it will need answering before Team mode matures past its first
  invite flow.
- If engineering time turns out tighter than expected before Product Hunt
  day, **Approach A is the correct fallback**, not a worse version of C —
  it's a real, smaller, well-precedented (emdash already runs it) piece of
  work, and the honest cost of falling back to it is losing some Team-mode
  conversions on launch day itself, which is worth stating to the founder
  directly rather than discovering after the fact.
- I am explicitly **not** recommending Approach B as written. Its
  architecture-once reasoning about the Clerk/schema mapping is sound and
  worth keeping as reference material for however Team mode's hosted half
  eventually gets built (under C, it's largely the same shape) — but its
  sequencing, specifically the sign-in gate in front of the whole app for
  every visitor, is wrong for a launch whose own strategy doc names the
  opposite as the product's actual wedge.

On the auth-provider question specifically (relevant only to Team mode's
hosted half, under C or B): both Clerk and WorkOS AuthKit are workable.
Clerk's Organizations primitive and prebuilt invite/switcher UI save real
time on exactly the Team-mode surface that matters; WorkOS AuthKit's free
tier (1,000,000 MAU, permanent, no application) makes cost a non-issue at
launch scale either way, and WorkOS documents an Electron-specific
integration path (`electron-authkit-example`, a "three calls" native-app
guide) more directly than Clerk's primarily web/Next.js-oriented docs,
which matters because Waypoint is an Electron app, not a Next.js site.
Neither is a load-bearing decision compared to the C-vs-B fork above — flag
it for the founder as a real but secondary choice, not a blocker.

## 4. What I'd want confirmed by the founder before building anything

These are product calls, not engineering ones — the engineering can start
once these have real answers:

1. **Is a rough, self-host-only Team mode acceptable for Product Hunt day
   itself, or is having some real invite path non-negotiable?** This is
   the actual fork between Approach A and Approach C — everything else
   about the two is close in cost. If the timeline forces A, that's a real
   choice to make consciously, not a fallback discovered under deadline
   pressure.
2. **What is Personal mode's free tier ever gated by — nothing, a
   session-count cap, a feature flag, something else?** If the honest
   answer is "nothing, ever," then even Approach A's minimal hosted piece
   (identity/licensing) has no product justification, and Personal should
   probably ship with zero hosted anything at all — strengthening C's case
   further. If there's a real monetization plan for Personal, that changes
   what the "optional account" in A or C is actually for.
3. **Does inviting someone into a solo workspace convert it into a team
   workspace, or does it always create a distinct one, leaving the solo
   workspace personal and separate?** Carried over unresolved from the
   existing design doc's §6 — still unresolved in every approach here. Not
   launch-blocking under C, but worth a real answer before Team mode's
   invite flow ships past a first version.
4. **Who is a Product Hunt team-persona visitor expected to be, under
   Approach A's self-host fallback specifically** — someone with the
   technical comfort to run `docker-compose up` and hand teammates a URL,
   or not? If not, A's Team story isn't really "deferred," it's "not
   shipped" for that visitor, and that's worth saying to the founder in
   those words rather than "self-host is available."
5. **Does the founder want the "your code and tickets are never uploaded,
   there is no Waypoint server" claim in `waypoint-product-strategy.md` to
   stay literally true for Personal mode specifically** — or is he
   comfortable narrowing or dropping that claim if Personal ends up needing
   hosted infrastructure for other reasons later (analytics, a future paid
   tier, cross-device sync)? This is the real product decision underneath
   the mechanism question — Approach C is built assuming the answer is
   "yes, keep it true for Personal"; if the founder doesn't actually care
   about that claim surviving, some of C's argument for keeping Personal
   fully local weakens, and A's minimal always-on account becomes more
   attractive.
6. **For "PM mode: see every ticket in the workspace"** (the existing
   design doc's own phrase, §5) **— what's the actual trust boundary for
   who's allowed into a team's board?** An explicit invite, a shared email
   domain, something else? This decides how much of the 32-of-40
   unscoped-service-files audit is truly launch-blocking under any hosted
   approach versus deferrable route by route.
