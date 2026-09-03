# Waypoint revamp — implementation architecture

Status: implementation architecture. Written to be executed by an engineer or a
follow-up agent who was not in the conversations that produced the inputs.

**Inputs, in order of authority:**

1. `waypoint-product-strategy.md` — the product argument and the decisions register.
2. `waypoint-revamp-mockup.html` — the target IA. A **product** spec, not an
   architectural one. Where it conflicts with the code, §1.9 rules on each case.
3. `waypoint-defingerprinting-plan.md` — the rename batch and its checklist.
4. `waypoint-differentiation-audit.md` — the current-state inventory. Superseded
   in its product half; still the best per-file map.

**What this document adds:** schema diffs, migrations, API shapes, a process
model for the agent runtime, commit boundaries, and a work breakdown. It also
records seven findings that none of the inputs account for and that change the
plan (§1). Read §1 first — two of them are blocking.

**Scale, for calibration.** 304 commits since 2026-08-21. Renderer 27,371 LOC;
backend 10,349; Electron main 5,372. 26 tables, 15 pg enums, 6 Drizzle
migrations. 14 MCP tools. No users, no deployment, no auth.

---

## 1. Findings that change the plan

These came out of reading the code against the docs. Each one moves work, cuts
work, or blocks work.

### 1.1 "Local-first" is currently Docker Desktop plus a Postgres server — BLOCKING for the machine surface

The position in strategy §1 and the "This machine" screen in the mockup both rest
on a data-at-rest story the product does not have.

What actually ships (`scripts/dev.sh`, `waypoint-backend/docker-compose.yml`,
`waypoint-backend/package.json`):

- The backend is **Express + PostgreSQL 16**, run as two Docker containers.
- `scripts/dev.sh` hard-fails if `docker compose ls` cannot reach the daemon.
- Postgres is published on `127.0.0.1:15432` with the credentials
  `waypoint/waypoint` baked into the compose file.
- The API listens on `localhost:14000` with **no authentication of any kind**.
  There is no auth middleware in `waypoint-backend/src/middleware/`. Identity is
  `CURRENT_USER_ID = 'mem-1'` in `waypoint-backend/src/lib/currentUser.ts`.
- The renderer talks to it over plain `fetch` with no credentials
  (`waypoint-frontend/src/renderer/mock/httpClient.ts`).
- The MCP endpoint `POST /mcp/copilot` is likewise unauthenticated and reachable
  by any process on the machine.

The mockup's `screen-machine` shows a **"Database → `~/Library/…/waypoint.db`"**
row with a "Reveal in Finder" button, and a "Size — 14.2 MB" row. There is no
`.db` file. There is a Postgres data volume inside a container.

This matters more than a cosmetic mismatch, because the governing rule is *no
surface may assert a state it does not verify*. Shipping that card as drawn would
be a new Tier 0 violation on the screen whose entire job is to be checkable.

Also note the precise claim in strategy §1 — "There is no Waypoint server" — is
**false as written**. There is a server; it is on loopback. The correct sentence
is "There is no Waypoint server you do not run," and that sentence still wins the
argument against Linear and Jira. Fix the copy; the wedge survives intact.

**Ruling.**

- **The "This machine" screen (strategy §4b) is blocked** until storage is
  decided. Do not build it against the current architecture. It is already in the
  7→8 tier, so this costs nothing today.
- The **sidebar machine strip** (§4a) can ship now, because everything on it is
  verifiable: repo count comes from `projects.repo_path IS NOT NULL`, and "Claude
  ready" comes from the real probe in §3.1. Drop the word "Local" from the strip
  until §1.1 is resolved, or make it read `● On this machine · 2 repos · Claude
  ready`.
- Storage is a **founder decision** (F1 in §10) with three options costed there.

### 1.2 There is no auth system, so "Change password" cannot be wired — it must be deleted

Strategy §7 offers "wire the password change or remove the form." Only the second
option exists. There is no `password` column on `members`
(`waypoint-backend/src/db/schema/workspace.ts`), no login endpoint, no session,
no token. `pages/auth/Login.tsx` accepts any non-empty email and navigates.

**Ruling: delete the change-password section and the device list from
`pages/profile-settings/Security.tsx` entirely.** What remains on that route is a
single honest paragraph: *"Waypoint runs on this machine and has no accounts.
There is nothing to sign in to and no password to change."* That is a true
sentence that also markets the product. Keep the route so the nav does not shift.

### 1.3 The webhook event names are not an external contract — there is nothing to break

The de-fingerprinting plan asks for an explicit decision on breaking the webhook
event names. The decision is already made by the code:
`waypoint-backend/src/services/webhooks.service.ts` is **21 lines** and contains
no `fetch`, no HTTP client, and no dispatch of any kind. The six event names
exist in exactly two places — a Zod enum at
`waypoint-backend/src/validation/misc.schema.ts:23-32` and a union at
`waypoint-frontend/src/renderer/types/entities.ts:276-281` — and are written into
`webhooks.event_types text[]` where nothing reads them.

**Ruling: renaming them is not a breaking change, because no event has ever been
delivered.** No compatibility window, no dual-emit. Rename the enum, add one
`UPDATE webhooks SET event_types = ...` statement to remap stored rows, and move
on. The item that *does* need attention is Tier 1: the Webhooks page promises
delivery and delivers nothing (§7).

### 1.4 A real Claude probe is cheaper than the docs assume — the plumbing already exists

`detectLocalClaudeCode()` is the only faked function left in
`waypoint-frontend/src/renderer/mock/api.ts` (lines 213-225). Everything it needs
already exists in the main process:

- `src/main/copilot/copilotConnect.ts:24-29` already carries
  `COMMON_INSTALL_DIRS` and a PATH-augmenting `buildEnv()`.
- `src/main/copilot/copilotAuth.ts:96-156` already runs a real one-shot probe
  query with a hand-rolled 20s timeout, and already exposes
  `ipcMain.handle('copilot:auth:status')`.
- `src/main/preload.ts` already exposes a `window.electron.copilot.auth`
  namespace to hang a new call off.

So the Tier 0 fix is a new `ipcMain.handle('copilot:detect')` that runs
`claude --version` with the augmented PATH, plus one preload method, plus three
UI states. Half a day, not a research project.

### 1.5 `agent_assignments` has a uniqueness constraint that forbids run history

`waypoint-backend/src/db/schema/agents.ts:86` declares
`unique().on(t.workItemId, t.agentId)`. One agent can therefore hold exactly one
assignment row per ticket, forever. A real runtime needs many runs per
(agent, ticket) pair — a nightly re-check, a retry, a second dispatch after a
rejection. Strategy §9 step 3 says "then `AgentAssignment.status` can move through
its real lifecycle"; it cannot, because the row is the link, not the execution.

**Ruling: `agent_assignments` stays as the link (unchanged, keep the unique
constraint), and a new `agent_runs` table becomes the execution record.** §5.4.

### 1.6 The renderer orchestrates every Copilot run, which an agent run cannot do

`src/main/copilot/copilotRunner.ts:509` is `ipcMain.on('copilot:run')` — a
fire-and-forget listener that streams back on `copilot:stream` to
`win.webContents`. Everything durable is owned by the renderer:
`CopilotPanel.tsx` builds the outcome preamble, persists `claudeSessionId` over
REST, chooses the `repoPath`, and enforces per-conversation ordering with a
`runGenerationRef`. The main process is stateless across turns except for one
`inFlight` map.

An agent run has to start from a backend event, run while the user is on a
different route or has the panel closed, and report into a queue rather than a
chat bubble. It cannot be renderer-orchestrated. This is the single largest piece
of the "wire Agents to the runtime" work and it is not visible in the two-week
estimate the strategy doc gives it. §5.

Two further gaps in the runner, both fine for interactive chat and both
unacceptable unattended:

- **No wall-clock timeout.** The only timeout anywhere in the Copilot subsystem is
  `PROBE_TIMEOUT_MS = 20_000` in `copilotAuth.ts:31`.
- **No concurrency cap.** `copilot:run` has no queue, no mutex, no busy flag.

### 1.7 Filtering happens in the renderer, which is why three of five layouts ignore filters

`pages/work-items/useWorkItemsView.ts` fetches and then filters/sorts/groups
client-side, and each layout instantiates it independently. The audit files this
as five bugs (§6, and the strategy doc's bug list). It is one missing boundary.

This matters far beyond the bug, because three separate features now need the
same filter to be evaluable: the unified ticket list, saved views (strategy §6),
and agent scope (strategy §5, "an agent's scope is a saved view"). Two
implementations of one filter — one in TypeScript in the renderer, one in SQL for
the trigger evaluator — is a guaranteed divergence.

**Ruling: filtering moves to the server, and there is exactly one evaluator.**
`GET /tickets?filter=<url-safe base64 of a versioned JSON filter>`. The renderer
sends the filter and renders what comes back; it never re-filters. This is the
prerequisite that makes the whole "views are filters, agents watch views" chain
buildable, and it is why §5 of the strategy doc correctly sits a tier above the
filter editor. §4.6 specifies the schema.

### 1.8 There is no client cache, and the proposals model now needs one

Zero hits across all 131 renderer files for react-query, SWR, zustand (it is in
`package.json` and imported nowhere), Redux, or even `createContext`. Every page
refetches on mount via `lib/useAsync.ts`.

The mockup's central promise is that one proposal appears on four surfaces and
resolving it anywhere resolves it everywhere ("Approved here, and gone from
Review — one queue, four surfaces"). With no shared cache, approving in the
Copilot panel leaves a stale card in the Review queue until that route remounts.

**Ruling: a minimal proposal store is a hard prerequisite for the Review queue,
not a nice-to-have.** Do not introduce react-query for the whole app — that is a
27k-line refactor nobody asked for. Introduce one scoped store for proposals
only: `src/renderer/lib/proposalStore.ts`, a subscribe/notify singleton in the
shape of the existing `lib/toast.ts` pub-sub, holding the pending set and
exposing `approve`/`reject` that patch optimistically and broadcast. ~150 lines.

### 1.9 Where the mockup and the code conflict — rulings

| # | Mockup shows | Reality | Ruling |
|---|---|---|---|
| 1 | `~/Library/…/waypoint.db`, 14.2 MB, "Reveal in Finder" | Postgres in Docker | **Code wins.** Defer the screen (§1.1). |
| 2 | "12 ran overnight" | Runs need the app open; there is no daemon | **Code wins.** Copy becomes "ran while Waypoint was open". Never promise runs while quit. |
| 3 | "Link duplicate" proposal kind | No relations model; relations are on the strategy §3 freeze list | **Cut from v1.** Narrow alternative in §4.3. |
| 4 | "Create doc" proposal kind | No `propose_create_page` tool | **Cut from v1.** Add when Docs earns it. |
| 5 | `Add…` offers "Requests queue" | Requests arrive from outside; the owner never creates the first one | **Mockup is wrong.** §3.4 gives Requests its own affordance. |
| 6 | Compass Web's `Add…` lists primitives it already has | Menu should list only unused ones | Mockup bug; build the described behaviour, not the drawn one. |
| 7 | "A single rejection sends that kind back to review" | An auto-applied proposal is never offered for rejection | **Hole in the mockup.** §4.5 adds Undo as the mechanism that makes the promise real. |
| 8 | Review-health strip with a median decision time | On first run there are zero decisions | **Honesty rule applies to the mockup too.** Render "not enough decisions yet", never a fabricated median. |
| 9 | One proposal, four surfaces, resolves everywhere | No client cache | **Mockup wins**, and §1.8 is the cost of it. |
| 10 | Trust table with per-kind counters | No table, no counters | **Mockup wins.** §4.5. |

---

## 2. Sequencing

### 2.1 The argument

Three constraints drive the order, and they are not the ones the strategy doc's
roadmap uses.

**Constraint A — the rename is a global-touch change and cannot run in parallel
with anything.** It edits `types/entities.ts`, `router.tsx`, every layout, ~40
pages, the backend schema, 20 route files, 25 services, the MCP tools, and the
Copilot system prompt. Any other branch open at the same time conflicts with it.
So the rename must land early (while the surface is smallest), alone, and fast.
This is the strongest sequencing claim in this document.

**Constraint B — proposals-as-a-first-class-concept is upstream of everything
agent-shaped.** The Review queue needs it. The agent runtime needs somewhere to
report into. Requests triage needs the same card. Earned trust needs a decision
history to compute over. It is not "part of the Review queue"; it is the schema
the Review queue, the runtime, and Requests all sit on.

**Constraint C — the typed filter is upstream of three things at once**: the
unified ticket list, saved views, and agent scope. It is a small piece of design
(§4.6) blocking a large amount of work, so it should be done early and cheaply
even though the features that consume it land later.

**Where I disagree with the strategy doc's roadmap.**

- "Wire Agents to the runtime — 2 weeks." The senior review said closer to four.
  I say **5–6 weeks**, and the delta is not the runner. Extracting the SDK core
  and honouring `agent.md`/`autonomy` is genuinely about a week (§5.2 — the tool
  policy is already parameterised on one boolean). The other four to five weeks
  are: the `agent_runs` table and claim protocol, the dispatcher and its process
  model, the trigger event bus, timeout/concurrency/retry/loop-prevention, the
  run-state UI, and the fact that the proposals rework has to land first. The
  review costed the runner; the work is the queue and the dispatcher.
- "Build the Review queue — 2 weeks." Roughly right for the screen, but only
  after the schema work (§4), which is another 1.5 weeks, plus §1.8's store.
  Call the pair **3 weeks**.
- "The tracker's finite list — one week." **2.5–3 weeks**, because §1.7 turns
  "make filters work in five layouts" into "move filtering to the server and
  define a versioned filter schema", which is more work and much better work.
- "The de-fingerprinting weekend." **4–6 days.** §6 explains why: pg enum
  surgery, the drizzle snapshot hazard, and the MCP/prompt atomicity constraint
  are each a half-day of care that a weekend estimate does not contain.
- "Tier 0 honesty pass — one day." **2 days**, because the real Claude probe is a
  main-process feature with IPC and three UI states, not a string edit.

**Total to the strategy doc's "7": about four months for one developer**, against
the doc's eight weeks. I would rather say that now than discover it in week nine.

### 2.2 The order

Phases are strictly sequential unless marked. Durations are one developer.

```
P0  Founder gate                                       1 hour, not an agent's job
     └─ answer defingerprinting §0 (did Plane code enter the repo?)
     └─ decide F1 (storage), F2 (autonomy levels), F3 (relations)

P1  Honesty and deletion                               6 days
     ├─ 1a Tier 0 fixes                                2 days
     ├─ 1b Delete pages/admin/** and pages/sessions/** 0.5 day
     ├─ 1c Copy purge (all three locations)            0.5 day
     ├─ 1d Capability register + Probe<T> + lint gate   1.5 days   ← §7
     └─ 1e Tier 1 sweep, driven by the register        1.5 days

P2  Rename                                             6 days   ← ALONE. No parallel work.
     ├─ 2a mock/ → data/ (mechanical path rename)      0.5 day
     ├─ 2b Vocabulary rename, 5 commits                4 days   ← §6
     └─ 2c Structural enum + column changes            1.5 days

P3  Foundations                          three tracks, parallelisable across agents
     ├─ 3a Proposals as first-class (schema + API)     8 days   ← §4.1-4.4
     ├─ 3b Typed filter + server-side filtering        6 days   ← §4.6
     └─ 3c Runner extraction (behaviour-preserving)    4 days   ← §5.2
     3a and 3b touch the backend; 3c touches only src/main. 3a and 3b conflict in
     validation/ and routes/index.ts only — sequence 3a then 3b if one developer.

P4  The Review queue                                   12 days
     ├─ 4a proposalStore + one ProposalCard component  3 days   ← §1.8
     ├─ 4b Review screen: segments, filters, bulk      5 days
     ├─ 4c Ticket detail + Copilot panel on the store  2 days
     └─ 4d Analytics tile: proposals approved/day      2 days   ← decision 10, do it FIRST if you can

P5  Sparse projects + unified ticket list              14 days
     ├─ 5a ProjectFeatures → sparse migration          3 days   ← §3.4
     ├─ 5b One TicketList component, three scopes      6 days
     ├─ 5c Saved-view filter editor                    3 days
     └─ 5d Keyboard layer                              2 days

P6  Agent runtime                                      25-30 days   ← §5
     ├─ 6a agent_runs schema + claim protocol          4 days
     ├─ 6b Dispatcher in Electron main                 6 days
     ├─ 6c agent.md / autonomy / policy                4 days
     ├─ 6d Trigger event bus (on-assign, on-label)     4 days
     ├─ 6e Failure, timeout, concurrency, loop guard   4 days
     ├─ 6f Run-state UI + Blocked segment              4 days
     └─ 6g Requests agent triage                       4 days

P7  Earned trust                                       6 days   ← §4.5
P8  Machine surface                                    blocked on F1
```

**Parallelism, if follow-up agents are doing this.** P1 and P2 must be one agent,
serially — they touch everything. From P3 on, the natural split is
backend-and-schema (3a, 3b, 4b's endpoints, 6a, 6d, 7) versus
Electron-main-and-runtime (3c, 6b, 6c, 6e) versus renderer (4a, 4c, 5b, 5c, 5d,
6f). The three touch disjoint directories after P2. Before P2 they do not.

---

## 3. Data model changes

Every migration is `npm run db:generate` in `waypoint-backend/` unless marked
**hand-written**, in which case create the `.sql` by hand and add its entry to
`drizzle/meta/_journal.json` following the existing shape. The current setup is a
clean, unmodified drizzle-kit flow — 6 migrations, journal version 7, snapshots
in sync — so generation works normally except where noted.

> **Two hazards, both real.**
> 1. `drizzle-kit generate` **prompts interactively** for rename-vs-drop on
>    renamed tables and columns. An agent running it non-interactively will get a
>    drop-and-recreate, silently destroying data. Every rename migration in §3.2
>    must be reviewed by a human before `db:migrate`, or hand-written.
> 2. **PostgreSQL has no `ALTER TYPE ... DROP VALUE`.** Removing an enum member
>    requires the rename-recreate-swap dance in §3.3. drizzle-kit will not emit
>    it.

### 3.1 Recommended: squash to a single baseline migration

The repo is 13 days old with no deployment and no user data. `npm run db:seed`
already truncates every table, and `POST /dev/reset` exists. Carrying six
migrations plus fifteen more rename migrations through this revamp buys nothing
and costs a week of enum surgery.

**Recommendation: after P2 lands on a green build, delete `drizzle/*.sql` and
`drizzle/meta/*`, regenerate a single `0000_baseline.sql`, and reseed.**

- Cost: one `docker compose down -v` and one `npm run db:seed` for anyone with a
  local database.
- **This is destructive and irreversible for local data.** Announce it, do it on
  its own commit, and put the recovery instruction in the commit message.
- The alternative is honest too: keep the incremental migrations if anyone has a
  local database they care about. Then every rename in §3.2 needs review under
  hazard 1 above, and the `triage` drop needs the hand-written migration in §3.3.

The rest of §3 is written for the incremental path, because that is the one with
real content. If you squash, most of it collapses into "edit the schema files."

### 3.2 The rename batch (P2b)

| # | From | To | Kind |
|---|---|---|---|
| 1 | table `work_items` | `tickets` | table rename |
| 2 | table `work_item_states` | `ticket_states` | table rename |
| 3 | table `work_item_links` | `ticket_links` | table rename |
| 4 | table `work_item_labels` | `ticket_labels` | table rename |
| 5 | table `work_item_assignees` | `ticket_assignees` | table rename |
| 6 | column `work_item_id` on `ticket_links`, `ticket_labels`, `ticket_assignees`, `comments`, `activity_entries`, `notifications`, `agent_assignments`, `copilot_proposals` | `ticket_id` | column rename ×8 |
| 7 | column `intake_requests.linked_work_item_id` | `requests.linked_ticket_id` | column rename |
| 8 | table `cycles` → `sprints`; `cycle_members` → `sprint_members`; `tickets.cycle_id` → `sprint_id` | | table + column |
| 9 | table `work_modules` → `workstreams`; `module_members` → `workstream_members`; `tickets.module_id` → `workstream_id` | | table + column |
| 10 | table `intake_requests` → `requests` | | table rename |
| 11 | table `pages` → `docs`; `pages.parent_page_id` → `docs.parent_doc_id` | | table + column |
| 12 | table `stickies` → `scratch_notes` | | table rename |
| 13 | column `projects.network` → `projects.visibility` | column rename |
| 14 | enum type `network` → `visibility` | **hand-written**: `ALTER TYPE "network" RENAME TO "visibility";` |
| 15 | enum type `intake_status` → `request_status` | **hand-written** `ALTER TYPE ... RENAME TO` |
| 16 | enum type `module_status` → `workstream_status` | **hand-written** |
| 17 | enum type `page_visibility` → `doc_visibility` | **hand-written** |
| 18 | enum value `copilot_proposal_kind.'create_work_item'` → `'create_ticket'` | **hand-written**: `ALTER TYPE "copilot_proposal_kind" RENAME VALUE 'create_work_item' TO 'create_ticket';` |
| 19 | `workstream_status` values `backlog\|planned\|in-progress\|paused\|completed\|cancelled` → `planned\|active\|paused\|done\|dropped` | **hand-written**, §3.3 pattern (six values to five, with a data remap) |
| 20 | `webhooks.event_types` values | data-only `UPDATE`, §3.5 |

Note `enum "network"` is used by **two** columns — `projects.network` and
`saved_views.visibility`. Renaming the type is one statement; the column rename
is separate and only applies to `projects`.

`activity_entries.verb` is plain `text`, not an enum (deliberately). The verb
renames (`module_added` → `workstream_added`, `cycle_added` → `sprint_added`,
`sub_item_added` → `subtask_added`) are therefore a data `UPDATE`, not a schema
change:

```sql
UPDATE activity_entries SET verb = 'workstream_added' WHERE verb = 'module_added';
UPDATE activity_entries SET verb = 'sprint_added'     WHERE verb = 'cycle_added';
UPDATE activity_entries SET verb = 'subtask_added'    WHERE verb = 'sub_item_added';
```

### 3.3 Dropping the `triage` state group (P2c) — hand-written, partly destructive

`state_group` currently has six values (`waypoint-backend/src/db/schema/projects.ts:5-12`).
`triage` is seeded as a real state per project by `DEFAULT_STATE_TEMPLATE`
(`projects.service.ts:62-69`, `{ name: 'Triage', group: 'triage', sortOrder: -1 }`)
and by `db/seed.ts:204`. On the renderer side it is effectively dangling:
`STATE_GROUP_ORDER` lists it first and `computeBreakdown` zero-initialises it,
but `BREAKDOWN_ORDER` in `cycle-utils.ts:50` deliberately excludes it and no page
ever creates or filters one.

The one thing that would be lost is the fact that a ticket arrived via a request.
So **add the replacement before removing the group**, in the same migration:

```sql
--> statement-breakpoint
-- 1. New provenance column. This is what replaces the triage group.
CREATE TYPE "ticket_source" AS ENUM ('manual','request','agent','import');
ALTER TABLE "tickets" ADD COLUMN "source" "ticket_source" NOT NULL DEFAULT 'manual';

--> statement-breakpoint
-- 2. Backfill provenance from the requests table before anything is dropped.
UPDATE "tickets" t SET "source" = 'request'
  FROM "requests" r WHERE r."linked_ticket_id" = t."id";

--> statement-breakpoint
-- 3. Move every ticket sitting in a triage state to that project's default
--    backlog state. RESTRICT on tickets.state_id makes this mandatory before
--    the states can be deleted.
UPDATE "tickets" t
   SET "state_id" = (
     SELECT s2."id" FROM "ticket_states" s2
      WHERE s2."project_id" = t."project_id" AND s2."group" = 'backlog'
      ORDER BY s2."sort_order" LIMIT 1)
 WHERE t."state_id" IN (SELECT "id" FROM "ticket_states" WHERE "group" = 'triage');

--> statement-breakpoint
DELETE FROM "ticket_states" WHERE "group" = 'triage';

--> statement-breakpoint
-- 4. Rebuild the enum without 'triage'. Postgres has no DROP VALUE.
ALTER TYPE "state_group" RENAME TO "state_group_old";
CREATE TYPE "state_group" AS ENUM ('backlog','unstarted','started','completed','cancelled');
ALTER TABLE "ticket_states" ALTER COLUMN "group" TYPE "state_group"
  USING "group"::text::"state_group";
DROP TYPE "state_group_old";

--> statement-breakpoint
-- 5. Exactly one default state per project must survive; Triage held isDefault.
UPDATE "ticket_states" SET "is_default" = true
 WHERE "id" IN (SELECT DISTINCT ON ("project_id") "id" FROM "ticket_states"
                 WHERE "group" = 'backlog' ORDER BY "project_id", "sort_order")
   AND NOT EXISTS (SELECT 1 FROM "ticket_states" s2
                    WHERE s2."project_id" = "ticket_states"."project_id" AND s2."is_default");
```

**Destructive:** step 3 loses which specific triage state a ticket was in. Step 2
preserves the only fact that mattered. Irreversible without a backup.

Companion source edits, all mechanical:
`projects.service.ts:68` (drop the template row), `db/seed.ts:204,312,404`,
`validation/projects.schema.ts:67,74`,
`components/domain/StateIcon.tsx:10,14,19` (drop the label, the `Inbox` case, and
the `STATE_GROUP_ORDER` entry), `pages/cycles/cycle-utils.ts:57` (drop the
`triage: 0` counter), `types/entities.ts` `StateGroup`.

"Needs triage" becomes a saved view once §4.6 exists:
`{ v: 1, sources: ['request'], stateGroups: ['backlog'] }`.

### 3.4 `ProjectFeatures` → sparse projects (P5a)

**The migration is one line and it is total information loss, on purpose:**

```sql
ALTER TABLE "projects" DROP COLUMN "features";
```

There is nothing to back up. The new model derives nav presence from whether the
primitive has rows. A project with `cycles: true` and zero cycles correctly loses
its Sprints entry; a project with `cycles: false` and cycle rows correctly gains
one. Note the server never enforced the flags anyway — `POST
/projects/:projectId/cycles` has no guard, so rows in a "disabled" primitive are
already possible today.

**Do not add a `hidden_primitives` escape hatch.** That is the toggle grid
wearing a different hat, which is exactly what strategy §4 removes.

**The read path needs one new endpoint, or it becomes an N+1.** The sidebar
renders every project and needs five counts each. Add to
`waypoint-backend/src/services/projects.service.ts`:

```ts
export interface PrimitiveCounts {
  sprints: number; workstreams: number; views: number; docs: number; requests: number;
}
// GET /projects returns each project with `primitiveCounts` attached.
// One query with five LATERAL counts, not five queries per project.
```

```sql
SELECT p.*, c.n AS sprints, w.n AS workstreams, v.n AS views, d.n AS docs, r.n AS requests
  FROM projects p
  LEFT JOIN LATERAL (SELECT count(*) n FROM sprints     s WHERE s.project_id = p.id) c ON true
  LEFT JOIN LATERAL (SELECT count(*) n FROM workstreams w WHERE w.project_id = p.id) w ON true
  LEFT JOIN LATERAL (SELECT count(*) n FROM saved_views v WHERE v.project_id = p.id) v ON true
  LEFT JOIN LATERAL (SELECT count(*) n FROM docs        d WHERE d.project_id = p.id) d ON true
  LEFT JOIN LATERAL (SELECT count(*) n FROM requests    r WHERE r.project_id = p.id) r ON true
 WHERE p.archived_at IS NULL;
```

**Requests needs a different affordance from the other four** (§1.9 #5). Sprints,
Workstreams, Views and Docs are all things the owner creates. A Request arrives
from outside. So Requests appears in the sidebar when
`primitiveCounts.requests > 0`, and `Add… → Enable the request form` is the
owner's action — which means one boolean survives after all, but it is a
*capability* ("accept submissions from outside") rather than a *feature toggle*
("show the Requests page"). Add `projects.accepts_requests boolean NOT NULL
DEFAULT false` in the same migration that drops `features`. Sidebar shows
Requests when `accepts_requests OR requests > 0`.

Deletions this unblocks: `pages/project-settings/Features.tsx` (109 lines),
`FEATURE_ROWS` in `CreateProjectModal.tsx:26-52` (also one of the three copied-prose
sites), `PATCH /projects/:id/features`, `projectFeaturesSchema`,
`updateProjectFeatures`, and the five near-identical "disabled for this project"
empty states at `CyclesPage.tsx:56`, `ModulesPage.tsx:100`,
`ProjectViewsPage.tsx:284`, `PagesPage.tsx:209`, `IntakePage.tsx:208`.

### 3.5 Webhook event value remap (data only)

```sql
UPDATE webhooks SET event_types = (
  SELECT array_agg(
    CASE e
      WHEN 'work_item.created' THEN 'ticket.created'
      WHEN 'work_item.updated' THEN 'ticket.updated'
      WHEN 'work_item.deleted' THEN 'ticket.deleted'
      WHEN 'cycle.created'     THEN 'sprint.created'
      WHEN 'module.created'    THEN 'workstream.created'
      ELSE e END)
  FROM unnest(event_types) e);
```

---

## 4. Proposals as a first-class concept

### 4.1 What exists, and why it is the right base

`waypoint-backend/src/db/schema/copilot.ts:86-132` plus
`src/services/proposals.service.ts` (514 lines) are the best code in the
repository and the design should preserve all of it:

- The seven-state machine `proposed → executing → executed | rejected | stale |
  expired | superseded`, where `executing` is a **claim** taken with a
  conditional `UPDATE ... WHERE status = 'proposed'` so N concurrent approves
  produce exactly one execution (`approveProposal`, lines 409-422).
- The lazy repair pass in `listProposals` that expires past-TTL rows and parks
  crashed claims as `stale` rather than back to `proposed` — because a crash
  between execute and finalize may have already written, and a second Approve
  would write twice (lines 226-255).
- `finalize()` guarded on `status = 'executing'` so a slow execute cannot stomp
  the repair's resolution (lines 330-352).
- Propose-time `snapshot` for display and staleness, deliberately never
  refreshed, so the card renders names and the *approve* moment is the only place
  reality is re-checked.
- Server-computed `disclosureText` so the card preview matches what
  `addComment` would actually write.
- Idempotent echo on re-approve/re-reject, so a double-click is harmless.

**None of this changes.** The rework is entirely about scope: the table is
conversation-scoped and the product needs it workspace-scoped.

### 4.2 Schema

Rename `copilot_proposals` → `proposals` and widen it.

```ts
// waypoint-backend/src/db/schema/proposals.ts  (moved out of copilot.ts)

export const proposalOriginEnum = pgEnum('proposal_origin', [
  'copilot',      // a Copilot conversation turn
  'agent_run',    // an autonomous agent run
]);

export const proposalDecidedByEnum = pgEnum('proposal_decided_by', [
  'user',         // a person clicked Approve or Reject
  'trust_grant',  // an earned-trust grant auto-applied it
  'system',       // expired / stale / superseded
]);

// UNCHANGED from copilot_proposal_kind, plus one addition.
export const proposalKindEnum = pgEnum('proposal_kind', [
  'comment', 'state_change', 'assignee_change', 'priority_change',
  'create_ticket',
  'add_label',        // NEW — the mockup's most common trust candidate
]);

// UNCHANGED, plus one terminal state for the Undo path (§4.5).
export const proposalStatusEnum = pgEnum('proposal_status', [
  'proposed', 'executing', 'executed', 'rejected',
  'stale', 'expired', 'superseded',
  'reverted',         // NEW — an executed proposal the user undid
]);

export const proposals = pgTable('proposals', {
  id: text('id').primaryKey(),

  // --- scope: this is the whole change ---------------------------------
  origin: proposalOriginEnum('origin').notNull(),
  // NOW NULLABLE. Non-null only for origin='copilot'.
  conversationId: text('conversation_id')
    .references(() => copilotConversations.id, { onDelete: 'cascade' }),
  // NOW NULLABLE. Non-null only for origin='copilot' (transcript anchor).
  anchorSeq: bigint('anchor_seq', { mode: 'number' }),
  // Non-null only for origin='agent_run'.
  agentRunId: text('agent_run_id')
    .references(() => agentRuns.id, { onDelete: 'set null' }),
  // Denormalised from the run/agent so the queue can filter without a join.
  // No FK cascade: an agent deleted mid-review must leave its proposals
  // readable, the same reasoning ticketId already uses.
  agentId: text('agent_id'),
  // Denormalised. NOT NULL. Every proposal belongs to exactly one project —
  // create_ticket carries it in the payload, everything else via the ticket.
  // This is what makes the Review queue's project filter one index scan.
  projectId: text('project_id').notNull(),
  // Set when the proposal originated from triaging an incoming request.
  sourceRequestId: text('source_request_id')
    .references(() => requests.id, { onDelete: 'set null' }),

  // --- unchanged from copilot_proposals --------------------------------
  kind: proposalKindEnum('kind').notNull(),
  ticketId: text('ticket_id'),           // deliberately not an FK, as before
  payload: jsonb('payload').notNull(),
  snapshot: jsonb('snapshot').notNull(),
  status: proposalStatusEnum('status').notNull().default('proposed'),
  statusReason: text('status_reason'),
  resultInfo: jsonb('result_info'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  modelNotifiedAt: timestamp('model_notified_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

  // --- decision provenance, new ----------------------------------------
  decidedBy: proposalDecidedByEnum('decided_by'),
  // The grant that auto-applied this, if any. Revoking a grant needs to find
  // everything it touched.
  trustGrantId: text('trust_grant_id')
    .references(() => agentTrustGrants.id, { onDelete: 'set null' }),
  // Wall-clock seconds between the row becoming visible and the decision.
  // Stored, not derived: the review-health strip needs it and it cannot be
  // reconstructed after the fact. NULL for system resolutions.
  decisionLatencyMs: integer('decision_latency_ms'),
}, (t) => [
  // The queue's hot query: pending, newest first.
  index('proposals_status_created_at_idx').on(t.status, t.createdAt),
  // Queue filters.
  index('proposals_project_status_idx').on(t.projectId, t.status),
  index('proposals_agent_status_idx').on(t.agentId, t.status),
  // Ticket detail's inline section.
  index('proposals_ticket_status_idx').on(t.ticketId, t.status),
  // The Copilot panel's transcript query, unchanged in shape.
  index('proposals_conversation_created_at_idx').on(t.conversationId, t.createdAt),
  // Trust computation: last N decisions for (agent, kind).
  index('proposals_agent_kind_resolved_idx').on(t.agentId, t.kind, t.resolvedAt),
]);
```

**Migration note.** Existing rows are all `origin='copilot'` with a non-null
`conversation_id`; backfill `origin = 'copilot'` and derive `project_id` from the
ticket (or from `payload->>'projectId'` for creates) before setting NOT NULL.

**The repair pass has to change shape.** Today it is
`WHERE conversation_id = $1 AND status = 'proposed' AND expires_at < now()`. The
aggregate queue has no conversation id, so the pass becomes workspace-wide and
would scan the table on every load. Add a partial index and keep it cheap:

```sql
CREATE INDEX proposals_pending_expiry_idx ON proposals (expires_at)
  WHERE status = 'proposed';
CREATE INDEX proposals_stuck_claim_idx ON proposals (resolved_at)
  WHERE status = 'executing';
```

Then run the repair on a 60-second interval from a single place
(`proposals.service.ts` `repairProposals()`, called by a `setInterval` in
`waypoint-backend/src/index.ts`) rather than inside every list call. Keep the
lazy call inside `listProposals` as a belt-and-braces, guarded by a
"last-repaired-at" module variable so it runs at most once a minute.

### 4.3 What is NOT added, and why

- **`link_duplicate`.** The mockup's second-most-visible proposal kind needs a
  relations model, and relations are explicitly on the strategy §3 freeze list.
  The narrow version that does not reverse that decision: one nullable column
  `tickets.duplicate_of_id text REFERENCES tickets(id) ON DELETE SET NULL`, which
  the audit §6.10 already argues for on its own merits (Requests has a
  `duplicate` status with nowhere to record *what* it duplicates). That is a
  founder decision (F3). Until it is made, **cut the kind** — do not build the
  card for a relation that cannot be stored.
- **`create_doc`.** Needs a `propose_create_doc` MCP tool and a Docs execute
  path. Cheap later, not load-bearing now.
- **A new `awaiting_review` proposal status.** Not needed. `proposed` already
  means exactly that.
- **Anything that changes the seven-state machine.** Auto-apply is not a new
  state; it is `proposed → executing → executed` with
  `decided_by = 'trust_grant'`.

### 4.4 API

Keep every existing endpoint working (the Copilot panel depends on them) and add
the aggregate surface. New file
`waypoint-backend/src/routes/reviewQueue.routes.ts`:

```
GET  /proposals
       ?status=proposed|blocked|recent      (segment; 'recent' = resolved in 24h)
       &agentId=…&projectId=…&kind=…        (filters)
       &limit=…&cursor=…                    (keyset on (created_at, id))
     → { proposals: ProposalView[], counts: { proposed, blocked, recent } }

GET  /proposals/counts                      → the three segment counts only.
                                              Polled by the sidebar badge.

POST /proposals/bulk-approve  { ids: string[] }
POST /proposals/bulk-reject   { ids: string[] }
     → { results: Array<{ id, status, statusReason }> }
     Each id runs the EXISTING single-row approveProposal/rejectProposal.
     Deliberately NOT one transaction: a stale row in the batch must resolve
     as stale and the rest must still execute. Cap the batch at 50.

POST /proposals/:id/revert                  → §4.5
GET  /tickets/:id/proposals?status=proposed → ticket-detail section
GET  /agents/:id/trust                      → the trust table
POST /agents/:id/trust  { kind, level }     → grant or revoke
```

**"Blocked" is a segment, not a status.** In the mockup, Blocked items are runs
that stopped and asked a question, not proposals. Model them as
`agent_runs.status = 'blocked'` with a `blocked_question text`, and have
`GET /proposals?status=blocked` return blocked *runs* projected into the same
card shape. One component, two row sources. This keeps the proposal state machine
untouched, which is worth more than uniformity of the query.

### 4.5 Earned trust — and the mechanism the mockup is missing

**Schema.**

```ts
export const trustLevelEnum = pgEnum('trust_level', ['ask', 'auto']);

export const agentTrustGrants = pgTable('agent_trust_grants', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  kind: proposalKindEnum('kind').notNull(),
  level: trustLevelEnum('level').notNull().default('ask'),
  grantedAt: timestamp('granted_at', { withTimezone: true }),
  grantedById: text('granted_by_id').references(() => members.id),
  // Set when the grant is revoked. The row is kept, never deleted, so the
  // agent page can show "auto-applied until you undid CW-143 on Sep 12".
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedByProposalId: text('revoked_by_proposal_id'),
  revokedReason: text('revoked_reason'),
}, (t) => [unique().on(t.agentId, t.kind)]);
```

**Counters are derived, never stored.** Storing them guarantees drift against the
proposals they summarise. The trust table is one query:

```sql
-- Last 25 user decisions for each (agent, kind).
SELECT agent_id, kind,
       count(*)                                        AS decided,
       count(*) FILTER (WHERE status = 'executed')     AS approved
  FROM (SELECT agent_id, kind, status,
               row_number() OVER (PARTITION BY agent_id, kind
                                  ORDER BY resolved_at DESC) rn
          FROM proposals
         WHERE agent_id IS NOT NULL
           AND decided_by = 'user'
           AND status IN ('executed','rejected')) w
 WHERE rn <= 25
 GROUP BY agent_id, kind;
```

`decided_by = 'user'` is the important filter: an auto-applied proposal must not
count as evidence toward keeping itself auto-applied.

**Thresholds** (constants in `proposals.service.ts`, matching the mockup):
`TRUST_WINDOW = 25`, `TRUST_MIN_DECIDED = 20`, `TRUST_MIN_APPROVAL_RATE = 0.93`.

**Granting is always a human act.** The queue *offers* — "Code Reviewer has been
right on 17 of its last 18 Link-duplicate proposals. Stop asking about this one
kind?" — and the user clicks. The product never silently stops asking. This is
the mockup's model and it is correct.

**The hole, and the fix.** The mockup promises "a single rejection sends that kind
straight back to review." Once a kind auto-applies, no proposal of that kind is
ever *offered* for rejection, so there is no rejection to detect. The promise has
no mechanism behind it.

**The mechanism is Undo, on the "Ran overnight" segment.** Every auto-applied
proposal appears there with an `Undo` action. `POST /proposals/:id/revert`:

1. Claim the row: `UPDATE proposals SET status='executing' WHERE id=$1 AND
   status='executed' AND decided_by='trust_grant'` — the same conditional-claim
   pattern `approveProposal` already uses, for the same reason.
2. Run the kind's inverse against the *snapshot's* from-values. Every kind stores
   one: `snapshot.fromStateId`, `snapshot.fromPriority`, `snapshot.wasAssigned`,
   and `resultInfo.commentId` / `resultInfo.ticketId` for the creates. If the
   current value no longer matches the snapshot's to-value, refuse with
   `stale` — the same staleness discipline as approve, in reverse.
3. `UPDATE proposals SET status='reverted', resolved_at=now()`.
4. **In the same transaction**, revoke the grant:
   `UPDATE agent_trust_grants SET level='ask', revoked_at=now(),
   revoked_by_proposal_id=$1, revoked_reason='undone' WHERE id = <grantId>`.

Step 4 is what makes the sentence on the agent page true. Without it, the sentence
is exactly the class of unverified assertion the honesty rule exists to catch.

**Undo window.** 7 days, or until the ticket changes again — whichever is first.
After that the action disappears and the row is history. Do not offer an Undo the
system cannot honour.

**Autonomy's relationship to trust.** These are two knobs and the docs conflate
them. The ruling: **autonomy sets the ceiling; trust grants are the mechanism.**

| autonomy | `tools` | MCP allowlist | Trust grants |
|---|---|---|---|
| `plan-only` | `Read/Glob/Grep` if a repo is linked, else `[]` | read tools only, **no `propose_*`** | forbidden |
| `ask-before-write` | same | read + all `propose_*` | forbidden |
| `trusted` | same | read + all `propose_*` | permitted |

**Recommendation: collapse the four-value `agent_autonomy` enum to these three.**
`ask-before-pr` is a level about pull requests in a product that has no concept of
a pull request and no code path that could open one. It is a fabricated
capability sitting in a select field, which is the same defect class as the
fabricated Claude version — smaller blast radius, identical kind. `full-auto`
becomes `trusted`, which describes what it actually does now that trust is
per-kind and earned. This is founder decision F2.

### 4.6 The typed filter (P3b)

One schema, one evaluator, three consumers (the ticket list, saved views, agent
scope).

```ts
// waypoint-backend/src/validation/ticketFilter.schema.ts — shared verbatim
// with the renderer via a copied type, or a tiny shared package.
export const ticketFilterSchema = z.object({
  v: z.literal(1),
  projectIds:    z.array(z.string()).optional(),
  stateIds:      z.array(z.string()).optional(),
  stateGroups:   z.array(stateGroupSchema).optional(),
  priorities:    z.array(prioritySchema).optional(),
  // '@me' and '@unassigned' are resolved server-side at query time, so a
  // saved view means "my open tickets" for whoever opens it.
  assigneeIds:   z.array(z.string()).optional(),
  labelIds:      z.array(z.string()).optional(),
  sprintIds:     z.array(z.string()).optional(),
  workstreamIds: z.array(z.string()).optional(),
  sources:       z.array(ticketSourceSchema).optional(),
  // Absolute ISO date, or a relative token like '-30d'.
  updatedBefore: z.string().optional(),
  createdAfter:  z.string().optional(),
  text:          z.string().max(200).optional(),
  includeDrafts: z.boolean().optional(),
}).strict();
```

- **Versioned from day one** (`v: 1`). `saved_views.filters` is currently
  untyped `jsonb` and every existing row is `{}` — `ProjectViewsPage.tsx:239`
  calls `createView(project.id, name, {})`. One-line data migration:
  `UPDATE saved_views SET filters = '{"v":1}'::jsonb WHERE filters = '{}'::jsonb;`
- **`saved_views.project_id` becomes nullable**, and project scope moves into
  `filters.projectIds`. That is strategy §6's "scope is part of the filter,"
  expressed in the schema. Migration: for every existing row, set
  `filters = jsonb_set(filters, '{projectIds}', to_jsonb(array[project_id]))`
  then `ALTER COLUMN project_id DROP NOT NULL`. Keep the column — a view whose
  filter names exactly one project can still denormalise it for listing.
- `GET /tickets?filter=<base64url>` is the single read path. `useWorkItemsView`
  keeps its grouping and sorting (presentation) and **loses its filtering**. That
  one deletion fixes the audit's "filters silently do nothing in
  Calendar/Spreadsheet/Gantt" for all three at once, because there is no longer a
  second place for filtering to not happen.

---

## 5. The agent runtime

This is the load-bearing item. It is also the one where the existing code is the
quality bar rather than the thing being replaced.

### 5.1 What the existing runner gets right, and must keep

From `src/main/copilot/copilotRunner.ts` — these are invariants, not preferences:

1. **`tools` and `allowedTools` are different knobs.** `allowedTools` only skips
   the approval prompt; `tools` controls availability. Both must be set on every
   call (lines 295-304, 332, 335).
2. **`settingSources: []` on every call.** The SDK default when omitted is "load
   everything"; isolation is opt-in. One missed call site silently re-enables the
   user's CLAUDE.md, skills, plugins, and custom agents (lines 236-251, 329).
3. **`strictMcpConfig: true`** (line 334) — no ambient MCP config.
4. **Scope identity rides a transport header, never a tool input.** The
   conversation id is baked into `mcpServersConfig()`'s `headers` (lines 212-230),
   so the model cannot choose or spoof where its proposals land. Any new scope
   identifier must follow this exactly.
5. **Never Bash/Edit/Write/Task/WebFetch/WebSearch, in any branch.**
   `REPO_READ_TOOLS = ['Read','Glob','Grep']` (line 151) and
   `REPO_DENYLIST_PATTERNS` (lines 123-144) are the product boundary, not a
   default a flag could flip.
6. **`Query.close()` must be called explicitly.** `for await` + `break`/`return`
   closes an inner generator and leaks the subprocess (lines 721-728).
7. **Every optional input from IPC or the DB is re-validated at the process
   boundary and degrades rather than fails** — bad conversation id means no
   header means proposals refuse cleanly; bad repo path means the unlinked
   branch. Never an error path.
8. **`repoLinked` is one boolean driving cwd, tool grants, and prompt variant**
   (lines 320-322), so the three can never disagree.

### 5.2 Extraction (P3c) — behaviour-preserving, no new features

Split `copilotRunner.ts` into a policy-parameterised core and two thin callers.

```
src/main/agent/
  claudeSession.ts     # NEW. The SDK invocation core, extracted verbatim.
                       #   runSession(policy, prompt, hooks) -> Promise<SessionResult>
                       #   Owns: buildOptions, buildEnv, resolveRepoRoot,
                       #   the generator loop, the stale-session retry, close().
  sessionPolicy.ts     # NEW. The Policy type + the two constructors.
  systemPrompt.ts      # NEW. Prompt composition (§5.3).
src/main/copilot/
  copilotRunner.ts     # SHRINKS to the ipcMain.on('copilot:run') adapter.
                       # Same IPC channels, same payloads, same behaviour.
  parseSdkMessage.ts   # unchanged
  claudeSdkClient.ts   # unchanged
  copilotAuth.ts       # unchanged
  copilotConnect.ts    # unchanged
```

```ts
// src/main/agent/sessionPolicy.ts
export interface SessionPolicy {
  /** Absolute path to a linked checkout, or null. Drives cwd, tools, prompt. */
  repoPath: string | null;
  /** Built-in tools. NEVER anything that can write or execute. */
  builtinTools: readonly string[];
  /** mcp__waypoint__* names this session may call. */
  mcpTools: readonly string[];
  /** Static headers baked into the MCP server config. Scope identity only. */
  mcpHeaders: Record<string, string>;
  systemPrompt: string;
  resumeSessionId?: string;
  /** Wall-clock ceiling. Copilot: undefined (user can see it hang and retry).
   *  Agent runs: REQUIRED. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}
```

`copilotRunner.ts` after the split builds exactly the policy it builds today, so
its 46-case test suite (`copilotRunner.test.ts`, 1073 lines) must pass unmodified.
**That suite is the acceptance criterion for P3c.** If it needs edits, the
extraction changed behaviour.

### 5.3 How `agent.md`, `autonomy` and `triggers` are honoured

**`agent.md` as system prompt — composed, not substituted.**

The agent's brief must not be able to remove the proposal contract or the
untrusted-data rule. Compose in this order, in `systemPrompt.ts`:

```
[1] IDENTITY        "You are {agent.name}, an agent inside Waypoint…"
[2] PROPOSAL CONTRACT   verbatim from COPILOT_SYSTEM_PROMPT_BASE lines 31-44
[3] UNTRUSTED DATA      verbatim from buildSystemPrompt lines 75-81
[4] SECRETS             verbatim from lines 85-87
[5] GROUNDING           the repoLinked / not-linked branch, lines 88-105
[6] BRIEF               "The workspace owner wrote the following brief for you.
                         Follow it, except where it conflicts with anything
                         above, which it cannot override.
                         <brief>\n{agents.instructions_content_markdown}\n</brief>"
[7] RUN CONTEXT         why this run started, what it is about, and the
                        outcomes of its own prior proposals (§5.6)
```

Constraints: cap the brief at **16 KB** (reject longer at save time in
`validation/agents.schema.ts`, with a visible character count in
`AgentDetailPage.tsx`); never interpolate it into a prompt without the
`<brief>` delimiters; never place it before [2]-[5].

**`autonomy` as tool policy** — the table in §4.5. In code this is a change to one
function:

```ts
export function policyForAgent(agent: Agent, repoPath: string | null): SessionPolicy {
  const repoLinked = repoPath !== null;
  const canPropose = agent.autonomy !== 'plan-only';
  return {
    repoPath,
    builtinTools: repoLinked ? REPO_READ_TOOLS : [],
    mcpTools: canPropose ? [...MCP_READ_TOOLS, ...MCP_PROPOSE_TOOLS] : MCP_READ_TOOLS,
    mcpHeaders: { 'x-waypoint-agent-run-id': runId },   // §5.1 invariant 4
    systemPrompt: buildAgentSystemPrompt(agent, repoLinked, runContext),
    timeoutMs: AGENT_RUN_TIMEOUT_MS,
    abortSignal: controller.signal,
  };
}
```

The backend's `POST /mcp/copilot` must learn a second scope header. Extend
`waypoint-backend/src/routes/mcp.routes.ts` to accept **either**
`x-waypoint-conversation-id` (existing shape `/^conv-[a-z0-9]{4,32}$/i`) **or**
`x-waypoint-agent-run-id` (`/^run-[a-z0-9]{4,32}$/i`), never both, and pass the
resolved scope into `createCopilotMcpServer`. `submitProposal` then sets
`origin`, `conversation_id`/`agent_run_id`, `agent_id` and `project_id` from the
scope rather than from tool input. Rename the route to `POST /mcp/waypoint` while
you are in the rename batch.

**`triggers` as invocation.** There is no event bus today. Do not add
infrastructure; add a function.

`waypoint-backend/src/lib/events.ts`, an in-process synchronous emitter called
from the same places `activity.service.logActivity` is already called from:

```ts
export type DomainEvent =
  | { kind: 'ticket.assignee_added'; ticketId: string; assigneeId: string; actorId: string }
  | { kind: 'ticket.label_added';    ticketId: string; labelId: string;    actorId: string }
  | { kind: 'comment.created';       ticketId: string; commentId: string;  actorId: string }
  | { kind: 'request.created';       requestId: string; projectId: string };

export function emit(e: DomainEvent): void;   // fire-and-forget, never throws
```

`src/services/agentDispatch.service.ts` subscribes once and enqueues
`agent_runs` rows:

| `agents.triggers` value | Event | Match |
|---|---|---|
| `on-assign` | `ticket.assignee_added` | `assigneeId === agent.id` |
| `on-label` | `ticket.label_added` | agent's watched views name that label |
| `on-comment-mention` | `comment.created` | body contains `@{agent.name}` |
| `on-request` (new) | `request.created` | agent is scoped to that project |
| `manual` | — | dispatched from the ticket's "Ask Copilot to…" menu |
| `on-view-change` | **deferred** | needs §4.6 shipped and a change-detection pass |

**Two guards, both mandatory:**

1. **Loop prevention.** Never enqueue a run from an event whose `actorId` is an
   agent. Without this, an agent's approved comment fires
   `on-comment-mention`, which produces another comment. `activity_entries.actor_id`
   and `comments.author_id` are already polymorphic, so the check is one lookup
   against `agents.id`.
2. **Rate cap.** `MAX_RUNS_PER_AGENT_PER_HOUR = 20`, enforced at enqueue with a
   count over `agent_runs.created_at`. Over the cap, the run is created with
   `status='blocked'` and `blocked_question = 'Rate limit reached'` so it is
   visible in the queue rather than silently dropped.

### 5.4 `agent_runs`

```ts
export const agentRunStatusEnum = pgEnum('agent_run_status', [
  'queued',          // enqueued by a trigger, nobody has claimed it
  'claimed',         // a dispatcher took it; heartbeat expected
  'running',         // the Claude session is live
  'awaiting_review', // finished, produced proposals still pending
  'blocked',         // stopped and asked a question, or hit a precondition
  'succeeded',       // finished; every proposal it made is resolved
  'failed',          // terminal error
  'timed_out',
  'cancelled',
]);

export const agentRuns = pgTable('agent_runs', {
  id: text('id').primaryKey(),                       // 'run-…'
  agentId: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // Null for runs not about one ticket (e.g. request triage before a ticket exists).
  ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  requestId: text('request_id').references(() => requests.id, { onDelete: 'set null' }),

  trigger: text('trigger').notNull(),                // which AgentTrigger fired
  triggerDetail: jsonb('trigger_detail'),            // the DomainEvent, for the audit trail
  intent: text('intent'),                            // dispatch intent, if manual

  status: agentRunStatusEnum('status').notNull().default('queued'),
  blockedQuestion: text('blocked_question'),
  errorKind: text('error_kind'),                     // 'auth' | 'spawn' | 'timeout' | 'generic'
  errorMessage: text('error_message'),
  summary: text('summary'),                          // the model's final text, capped

  attempt: integer('attempt').notNull().default(0),
  // The claim token. A dispatcher heartbeats this; a claim with no heartbeat
  // for CLAIM_STALE_MS is reclaimable. Same pattern as proposals' 'executing'.
  claimedBy: text('claimed_by'),                     // instance id of the dispatcher
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),

  claudeSessionId: text('claude_session_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('agent_runs_status_created_idx').on(t.status, t.createdAt),
  index('agent_runs_agent_created_idx').on(t.agentId, t.createdAt),
  index('agent_runs_ticket_idx').on(t.ticketId),
]);
```

`agent_assignments` stays exactly as it is — the link between an agent and a
ticket, with its `unique(work_item_id, agent_id)`. Its `status` column becomes a
**derived projection of the latest run** rather than an independently-written
field, which is what finally makes the existing
`queued|running|needs-review|blocked|done|failed` values reachable outside
`db/seed.ts`. Update it in the same transaction that writes a run's terminal
status.

### 5.5 Process model

**Where the dispatcher lives: Electron main.** The Claude credentials, the
`CLAUDE_CONFIG_DIR` isolation, the vendored `claude` binary inside
`app.asar.unpacked`, and the user's local checkouts are all on the desktop side.
The backend has the data and the triggers. Moving credentials to the backend
would be strictly worse.

**So: the backend owns the queue; Electron main owns execution.**

```
  backend                         Electron main                     Claude
 ┌──────────────────┐   poll     ┌───────────────────┐  runSession  ┌────────┐
 │ agentDispatch    │◀───────────│ dispatcher.ts     │─────────────▶│ claude │
 │  .service        │   claim    │  - 5s interval    │              │  proc  │
 │                  │◀──────────▶│  - concurrency 2  │◀─────────────│        │
 │  agent_runs      │  heartbeat │  - heartbeat 10s  │  MCP over    └────────┘
 │  proposals       │◀───────────│  - timeout 10min  │  localhost      │
 └──────────────────┘   report   └───────────────────┘                 │
        ▲                                 │                            │
        └─────────────────────────────────┼────────────────────────────┘
             propose_* via POST /mcp/waypoint, scoped by x-waypoint-agent-run-id
                                          │
                                          ▼  webContents.send('agent:run-updated')
                                     renderer (invalidates proposalStore)
```

**The claim protocol** is the one already proven in `approveProposal`:

```sql
UPDATE agent_runs
   SET status='claimed', claimed_by=$1, claimed_at=now(), heartbeat_at=now()
 WHERE id = (SELECT id FROM agent_runs
              WHERE status='queued'
                 OR (status IN ('claimed','running')
                     AND heartbeat_at < now() - interval '60 seconds')
              ORDER BY created_at LIMIT 1
              FOR UPDATE SKIP LOCKED)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` because two Electron windows (or a dev instance beside a
packaged one) can both poll. Exposed as `POST /agent-runs/claim`.

**Constants:**

| Constant | Value | Why |
|---|---|---|
| `POLL_INTERVAL_MS` | 5_000 | A trigger-to-start latency of ≤5s reads as immediate |
| `MAX_CONCURRENT_RUNS` | 2 | Two `claude` subprocesses on a laptop is the honest ceiling |
| `AGENT_RUN_TIMEOUT_MS` | 600_000 | The gap §1.6 identifies. Enforced with `AbortController` + `query.close()` |
| `HEARTBEAT_MS` | 10_000 | |
| `CLAIM_STALE_MS` | 60_000 | Matches the existing `EXECUTING_STUCK_MS` |
| `MAX_RUNS_PER_AGENT_PER_HOUR` | 20 | Trigger-loop backstop |
| `MAX_ATTEMPTS` | 2 | One retry, §5.7 |

**App lifecycle.** Runs only happen while Waypoint is open. `before-quit` calls
the dispatcher's shutdown, which aborts in-flight sessions and releases their
claims back to `queued` (not `failed` — nothing went wrong). This is why mockup
conflict #2 matters: the Agents page must say *"Runs happen while Waypoint is
open"*, and the overnight copy must not promise otherwise.

### 5.6 Reporting outcomes back to an agent

The Copilot loop delivers proposal outcomes as a bracketed preamble on the *next*
turn (`useCopilotProposals.buildOutcomePreamble`, gated once by
`modelNotifiedAt`). An agent run is one-shot; there is no next turn.

**Solution: deliver at run start, not run end.** Section [7] of the composed
prompt (§5.3) includes the outcomes of that agent's own previously-unnotified
proposals, built by the same `outcomeSentence()` logic and marked notified when
the run completes successfully. This reuses `modelNotifiedAt` exactly as
designed, needs no new column, and makes the trust loop legible to the agent
("your last four label proposals were approved").

Same discipline as the existing code: the preamble is built from the proposal's
own status and snapshot identifiers only — **never model-authored text** — so a
proposal cannot smuggle instructions into a later prompt.

### 5.7 Failure handling

| Failure | Detection | Response |
|---|---|---|
| SDK/binary fails to start | `runCopilotQuery` throws before the generator | `failed`, `errorKind='spawn'`, message from `describeSdkStartupError`. No retry — deterministic. |
| Auth failure | `parseSdkMessage` → `auth_error` | `failed`, `errorKind='auth'`. **Deactivate every agent** (`agents.is_active = false`) and surface one banner. Do not let 12 queued runs each burn a failure. |
| Stale Claude session | `STALE_SESSION_PATTERN` | Already handled inside `claudeSession.ts`, bounded to one retry. Invisible to the run. |
| Model error mid-run | `result_error` | `failed`, `errorKind='generic'`, message shown in Blocked. |
| Timeout | `AbortController` at `AGENT_RUN_TIMEOUT_MS` | `timed_out`. **Do not retry** — a 10-minute run that produced nothing will produce nothing again. |
| Dispatcher crash / app quit mid-run | `heartbeat_at` goes stale | Reclaimed by the next poll. **Only retried if the run produced zero proposals** — the reclaim query must check `NOT EXISTS (SELECT 1 FROM proposals WHERE agent_run_id = …)`. A run that already proposed must go to `awaiting_review`, never re-run, or it double-proposes. |
| Backend unreachable | MCP tool calls fail inside the turn | The run completes with no proposals. `succeeded` with a summary. Do not fail the run — that is the existing runner's documented behaviour and it is correct. |
| Repo path gone | `resolveRepoRoot` statSync throws | Degrade to unlinked, exactly as today. If the agent's brief needs code, it emits `[[NEEDS_REPO]]` → `blocked`, `blockedQuestion = 'No repo linked for {project}'`. This is mockup proposal `b2`. |

`MAX_ATTEMPTS = 2` applies only to the reclaim-after-crash case. Everything else
is one shot.

### 5.8 Security review of the new surface

The runner's posture (§5.1) carries over intact. Three things are genuinely new:

1. **`agent.md` is untrusted-ish input reaching a system prompt.** It is
   user-authored, which makes it *instructions*, not data — that is the point of
   the feature. Mitigations: the composition order in §5.3 (safety before brief),
   explicit `<brief>` delimiters, the 16 KB cap, and the sentence saying the brief
   cannot override what precedes it.
2. **A run's scope identity is a new header.** Follow invariant 4 exactly: baked
   into `mcpServersConfig`, pattern-validated on both sides, never a tool input.
   A malformed id must degrade to "proposals unavailable", not fail.
3. **The MCP endpoint remains unauthenticated** and now accepts a second scope
   header, so any local process can post proposals attributed to any run whose id
   it guesses. Run ids are nanoid, so guessing is impractical, but this is worth
   naming: **`POST /mcp/waypoint` should get a bearer token** — a random secret
   generated on first backend boot, stored in the backend's data dir, read by
   main and sent as `Authorization`. Half a day, and it closes the one gap the
   runner's own author flagged. Do it in P6.

---

## 6. Rename execution plan

### 6.1 The two atomic constraints

**Constraint 1 — MCP tool names and the Copilot system prompt in one commit.**
The tool names live in three places that must move together:

- `waypoint-backend/src/mcp/workItemTools.ts` and `proposalTools.ts` —
  `registerTool('<name>', …)` **and** the `withErrorSafetyNet('<name>', …)` string
  literal for the same tool.
- `waypoint-frontend/src/main/copilot/copilotRunner.ts:168-183` — the
  `MCP_TOOLS` array of `mcp__waypoint__*` names.
- `copilotRunner.ts:24-45` — `COPILOT_SYSTEM_PROMPT_BASE`, which describes the
  tools in prose ("you can look up, list, and search work items (tickets)").

If `MCP_TOOLS` names a tool the server does not register, the SDK's
`allowedTools` silently omits it and the model has no write path — it will
narrate what it would do and end its turn. That is a silent failure, not an
error, which is why this must be one commit.

**Constraint 2 — the `mock/` path rename is its own commit, before the
vocabulary rename.** `mock/api.ts` is the production HTTP layer despite the name;
~90 files import from `@/mock/api`. Rename `mock/` → `data/` first, as a pure
path rewrite verified by `tsc`, so the vocabulary diff is readable.

### 6.2 Commit boundaries

Five commits, in this order, each of which must leave `npm run build && npm test`
green in both halves.

| # | Commit | Contents |
|---|---|---|
| C1 | `refactor: rename mock/ to data/` | Path-only. `git mv`, then rewrite `@/mock/` → `@/data/`. Zero semantic change. |
| C2 | `refactor(db): rename work items to tickets` | Backend schema + migration + routes + services + validation, **and** the renderer types/pages/routes that consume those paths. Includes `WorkItem`→`Ticket`, `WorkItemState`→`TicketState`, `work-items` routes, `/work-items` URL, "Sub-work items"→"Subtasks". |
| C3 | `refactor(db): rename cycles/modules/intake/pages/stickies` | Sprints, Workstreams, Requests, Docs, Scratchpad. Same both-halves shape. Includes `WorkModule.status` collapse and `webhooks.event_types` remap. |
| C4 | **`refactor(mcp): rename tool surface and the Copilot prompt`** | `workItemTools.ts`, `proposalTools.ts`, `MCP_TOOLS`, `COPILOT_SYSTEM_PROMPT_BASE`, `copilot_proposal_kind.create_work_item` → `create_ticket`. **Atomic — see constraint 1.** |
| C5 | `refactor: labels, visibility, and copy` | `Network`→`Visibility`, `Categories`→`Sizes`, `Archives`→`Archive`, `Billing and plans`→`Billing`, `Your work`→`My work`, Notifications heading, `Work Structure`→`Ticket setup`, README. |

C2 and C3 are big but each is one vocabulary cluster; a bisect that lands between
them leaves a coherent half-vocabulary that still builds. A commit that split
backend from frontend would not.

### 6.3 Mechanical vs judgment

**Mechanical** — a scripted rename plus `tsc`:

- Type names, interface names, file names, route paths, column and table names.
- `GROUP_BY_OPTIONS`, `RECENTS_FILTER_OPTIONS`, `VIEW_TABS`, `EVENT_TYPES`,
  `STATE_GROUP_ORDER`, `RecentType`, search-palette group labels, activity verbs.
- The 8 × `work_item_id` → `ticket_id` column renames.

**Judgment — a human reads every one:**

- **All prose.** The copy purge (`Features.tsx:14-36`,
  `Automations.tsx:122-131`, `CreateProjectModal.tsx:26-52`) plus the ~20
  `EmptyState` descriptions. A rename script must not touch these; they are
  rewrites, and the third location is the one the original audit missed.
- **The Copilot system prompt.** Not a find-and-replace. "work items (tickets)"
  becomes "tickets", and the sentence structure changes.
- **`Page`, `page`.** `waypoint-backend/src/mcp/workItemTools.ts:77` defines a
  pagination helper `function page<T>(rows, effectiveLimit)`. Renaming it to
  `doc` would be a real bug. Same for "webpage" in `app.ts` comments.
- **`module`.** `vi.mock` / ESM "module" appears in
  `copilot.routes.test.ts` and `proposalTools.test.ts` and is unrelated.
- **`work_modules`** — the table is `work_modules` but the route, service and
  feature key are all `module`. Do not assume the prefix is consistent.
- **Duplicate filenames.** Three `General.tsx`, two `Members.tsx`, two
  `Notifications.tsx`, all aliased in `router.tsx`. A path-based script will
  collide.

### 6.4 How to avoid a half-renamed codebase across sessions

The plan says a partial rename is worse than none. Make that mechanically true:

1. **A tripwire test, added in C1 and removed in C5.**
   `waypoint-frontend/src/renderer/__tests__/vocabulary.test.ts` greps the source
   tree for banned identifiers and fails on any hit. Populate it cluster by
   cluster: after C2 it bans `WorkItem`, `work_item`, `work-items`; after C3 it
   adds `Cycle`, `Module`, `Intake`, `Sticky`. Because it fails the build, a
   session that stops mid-cluster leaves a red suite, not a plausible-looking
   half-rename.
2. **A single `git rebase --autosquash`-friendly branch.** Do not merge C1-C5
   individually to `main`. Merge the set or none.
3. **A one-line state file at the top of the branch**,
   `docs/design/RENAME-STATE.md`, listing the five commits with a `[x]` per
   landed one, updated in the same commit. A follow-up agent reads it in one
   file read and knows exactly where it is.
4. **Regenerate `drizzle/meta` only once**, at the end of C3, and review the
   emitted SQL by hand for `DROP TABLE`/`DROP COLUMN` before running
   `db:migrate`. drizzle-kit's interactive rename prompt is the hazard here
   (§3, hazard 1).

---

## 7. Enforcing "no surface may assert a state it does not verify"

The interesting question, and the honest answer starts with what cannot work.

**A lint rule cannot catch the general case.** The burndown chart is the proof:
`cycle-utils.ts:84-124` produces two real data points and `null` for every day
between, and recharts joins them into what reads as a trend. Every line of that
is legitimate code; the lie is in the composition, and the code comment is
*honest about it* while the chart is not. No AST rule finds that. Any answer
built purely on linting is theatre.

So: three layers, cheapest first, and the cheapest one is the one that matters.

### 7.1 Layer 1 — the capability register (ship this first, half a day)

One file. `waypoint-frontend/src/renderer/capabilities.ts`:

```ts
/**
 * Every surface that promises something must have an entry here, and every
 * entry that is not 'shipped' must render <NotWired/> where the promise is.
 * Adding a surface without an entry is a review failure. This file is the
 * answer to "is anything in the product lying right now?" — one file read.
 */
export type CapabilityState = 'shipped' | 'partial' | 'not-wired';

export interface Capability {
  state: CapabilityState;
  /** What the user sees where the promise used to be. Required unless shipped. */
  note?: string;
  /** Where the gap is, so the next person can find it. */
  ref?: string;
}

export const CAPABILITIES = {
  'webhooks.delivery': { state: 'not-wired',
    note: 'Webhooks are saved but nothing is delivered yet.',
    ref: 'services/webhooks.service.ts has no dispatch' },
  'exports.download': { state: 'not-wired',
    note: 'Exports are recorded but no file is produced yet.',
    ref: 'exports.service.ts inserts status:completed and returns' },
  'automations.autoArchive': { state: 'not-wired',
    note: 'This setting is saved but nothing acts on it yet.' },
  'automations.autoClose': { state: 'not-wired', note: '…' },
  'profile.notificationPrefs': { state: 'not-wired', note: '…' },
  'preferences.firstDayOfWeek': { state: 'not-wired',
    note: 'The calendar currently always starts on Monday.' },
  'requests.publicForm': { state: 'not-wired',
    note: 'The public submission form is not published yet.' },
  'sprints.burndown': { state: 'partial',
    note: 'Two measured points — today and the sprint start. No daily history is recorded yet.' },
  'tickets.drafts': { state: 'not-wired',
    note: 'Nothing saves a draft yet, so this list cannot fill.' },
  'agents.runtime': { state: 'not-wired',
    note: 'This agent is configured but not yet running. Assignments will queue.' },
} as const satisfies Record<string, Capability>;
```

Plus one component, `components/ui/NotWired.tsx`, which renders the note in a
consistent, unmissable style and takes a `CapabilityKey` — so it cannot be
rendered with prose someone invented at the call site.

This is Layer 1 because it does three things at once: it makes the Tier 1 sweep
(P1e) a mechanical exercise (walk the register, place the component), it makes
"what is inert right now" a diffable artifact, and it survives contact with the
cases a linter cannot see — the burndown entry above is exactly such a case.

### 7.2 Layer 2 — a type that makes the fabricated-status bug unrepresentable

The `detectLocalClaudeCode` class of bug is a claim about *external* state. Make
those claims carry their evidence:

```ts
// waypoint-frontend/src/renderer/types/probe.ts
export type Probe<T> =
  | { state: 'unknown' }
  | { state: 'checking' }
  | { state: 'present'; value: T; observedAt: string; via: string }
  | { state: 'absent';  reason: string; observedAt: string; via: string }
  | { state: 'error';   reason: string; observedAt: string; via: string };
```

`via` is the load-bearing field: the literal thing that was executed
(`'claude --version'`, `'GET /health'`). You cannot construct a `present` without
naming what you ran. A `<StatusBadge probe={…}/>` that accepts only a `Probe<T>`
cannot render a green dot for an unprobed state, because there is no branch for
it — and there is nowhere to put a version number that was not read.

Apply it to: Claude Code detection, backend reachability, repo-link state,
per-repo git branch, and the sidebar machine strip. Five surfaces, all of them
claims about the world outside the process.

### 7.3 Layer 3 — one narrow lint rule, on its own hard-gated CI step

The existing `npm run lint` runs with `continue-on-error: true` in
`.github/workflows/test.yml` and reports 100+ pre-existing violations. **Adding a
rule there means it never blocks anything.** So this gets its own script and its
own required step.

`npm run lint:honesty` — `eslint --no-eslintrc --rulesdir eslint-rules` over
`src/renderer/**`, with exactly one rule to start:

**`no-inert-control`** — reports a JSX `onClick`/`onSubmit`/`onChange` prop whose
function body contains no call expression other than `console.*`, a `setState`
setter, and `close()`. Narrow on purpose: it fires on
`WorkItemDetailPage.tsx:644,652,660` (the three `console.log` menu items) and on
`Security.tsx:36-43` (setState-only, then a success message), and on essentially
nothing else. A legitimate local-state-only handler adds
`// eslint-disable-next-line no-inert-control -- purely visual, see CAPABILITIES['x']`,
which is a comment a reviewer will read.

A missing-`onClick` variant (`Security.tsx:133`'s Revoke,
`Tokens.tsx:20`'s "Add access token") is a second, even simpler rule:
**`no-actionless-button`** — a `<Button>` with no `onClick`, no `type="submit"`,
and no `href`.

Do **not** attempt a rule that pattern-matches success copy ("Password updated",
"Saved"). The false-positive rate makes it noise, and Layer 1 covers the same
ground with a human in it.

### 7.4 The review rule as written

Add to `.github/PULL_REQUEST_TEMPLATE.md`:

> **Honesty check.** For every surface this PR adds or changes: does it assert
> anything — a status, a count, a success, a trend, a version — that it did not
> read from a source in this same change? If yes, either read it, render
> `<NotWired>` from `capabilities.ts`, or delete the surface. Third option is
> usually right.

---

## 8. Risk register

Ordered by expected cost, not probability.

| # | Risk | Likelihood | Reversibility | Safety net |
|---|---|---|---|---|
| R1 | **The §0 provenance question is not clean.** If Plane source entered the repo, AGPL-3.0 obligations attach to the derived work and every rename in §6 becomes concealment rather than hygiene. | Unknown — nobody has checked | Not reversible by engineering | **This is the gate. P0 blocks P1.** One hour of `git log --all -S'makeplane'` etc., by the founder, before a line is written. |
| R2 | **The rename lands half-done across sessions.** 43k LOC, five commits, an interactive drizzle prompt in the middle. | High if unmanaged | Reversible but expensive — a hybrid vocabulary costs readability *and* keeps the fingerprint | §6.4: the tripwire test, the state file, merge-the-set-or-none, and hand-review the generated SQL. |
| R3 | **`drizzle-kit generate` drops a renamed table instead of renaming it.** It prompts interactively; a non-interactive run picks drop-and-recreate. | High if an agent runs it unattended | Irreversible data loss | Never run `db:generate` unattended during P2. Hand-review every emitted `.sql` for `DROP TABLE`/`DROP COLUMN`. Prefer the §3.1 squash, which sidesteps this entirely. |
| R4 | **The agent runtime is 5-6 weeks, not 2, and gets cut halfway.** Strategy §9 sets a one-month deadline after which the Agents surface is deleted. A half-wired runtime is worse than none: a green dot on a page whose runs silently queue. | Medium-high | Reversible | Ship §5 in the order given. **6a-6c alone (schema + dispatcher + policy) already produce a working `manual` trigger** — a run you start from the ticket menu that lands in Review. That is the demoable milestone at ~2.5 weeks. Triggers, trust and Requests are additive after it. |
| R5 | **Storage decision (F1) drifts.** The "This machine" screen, the offline story, the README, and the onboarding all depend on it, and every week it is unmade is a week of copy written against an unknown. | Medium | The longer it waits, the harder — PGlite vs SQLite diverge in dialect | Decide at P0. §10 F1 costs all three options. Meanwhile **do not write any copy that names the storage**. |
| R6 | **Auto-apply writes something the user did not want and Undo cannot reverse it.** | Low but severe — it is the exact failure the whole propose→approve design exists to prevent | Depends on the kind | Undo (§4.5) with a snapshot-checked inverse, refusing when reality has moved. Grants are human-only. Ship trust (P7) **last**, after the queue has produced real decision history. Never ship auto-apply and the queue in the same release. |
| R7 | **Trigger loop.** An agent's approved comment fires `on-comment-mention` and produces another comment. | Medium — it is one missing check away | Reversible, but burns the user's Claude quota while it runs | The two guards in §5.3: never trigger from an agent actor; `MAX_RUNS_PER_AGENT_PER_HOUR = 20` with over-cap runs made visible as `blocked`, not dropped. |
| R8 | **The unauthenticated MCP endpoint + a second scope header.** Any local process can post proposals. | Low (single-user desktop) | Easy to fix | The bearer token in §5.8.3. Half a day. Do it in P6. |
| R9 | **No client cache means the four surfaces disagree.** Approve in the panel, the queue still shows it. | Certain, without §1.8 | Easy | `proposalStore.ts` is a P4a prerequisite, not a polish item. |
| R10 | **The review queue becomes a rubber stamp.** If it does, the product's whole safety claim is theatre with extra clicks. | Medium | Not an engineering problem | The mockup's health strip is the right instrument — keep it, and make it render "not enough decisions yet" rather than a fabricated median (§1.9 #8). Instrument proposals-approved-per-active-day (P4d) **before** shipping the queue, per decision 10. |
| R11 | **Deleting `pages/sessions/**` loses something.** ~900 lines, one genuinely good idea. | Low | One-way, but git remembers | Harvest `INTENTS` and `INTENT_NEEDS_DIRECTORY` into the ticket menu in the *same* commit as the deletion, so the good idea cannot be lost by forgetting a follow-up. |

### What I would cut

Plainly, in order of confidence:

1. **`ask-before-pr`.** The product has no pull requests and no code path that
   could open one. It is a fabricated capability in a select field. Cut it (F2).
2. **`link_duplicate` and `create_doc` proposal kinds.** Build the queue with
   five kinds plus `add_label`. Neither is needed to prove the model works, and
   `link_duplicate` needs a schema decision the freeze list forbids (F3).
3. **`on-view-change` triggers.** They need the typed filter *and* a
   change-detection pass over view membership. `on-assign` and `on-label` prove
   the trigger mechanism at a fraction of the cost. Defer to after P7.
4. **The "This machine" screen, until F1.** Not a cut — a block. Building it now
   means building it twice or shipping a lie.
5. **Full react-query adoption.** Tempting during P4, and a 27k-line detour. One
   scoped proposal store, ~150 lines.
6. **The `executionMethod` enum's three unreachable values.** `local-codex-`,
   `local-gemini-`, `hosted-api-key` are rendered as disabled "Roadmap" cards in
   `agentTemplates.ts`. That is honest today, and it will stop being honest the
   moment someone treats the enum as a plan. Low priority; mention it in review.

### What I would not cut, though it will be tempting

**The typed filter (P3b).** It looks like tracker polish and it is actually the
join between three separate features. Cutting it means the ticket list stays
broken in three layouts, saved views stay unconfigurable, and "agents own saved
views" has nothing to stand on.

---

## 9. Work breakdown

Each unit is independently mergeable and states its acceptance criterion. Sizes
are one developer-day.

### P1 — Honesty and deletion

**W1.1 · Delete the fake security surfaces · 0.5d**
Delete `SESSIONS`, the device list and the change-password form from
`pages/profile-settings/Security.tsx`; replace with the honest paragraph in §1.2.
*Accept:* the route renders, contains no form, no `SESSIONS` const, and no
`setSaved(true)` without a preceding `await`.

**W1.2 · Real Claude Code detection · 1d**
Add `ipcMain.handle('copilot:detect')` in a new
`src/main/copilot/copilotDetect.ts` that spawns `claude --version` with
`copilotConnect.ts`'s augmented PATH and a 5s timeout. Expose
`window.electron.copilot.detect()`. Replace `detectLocalClaudeCode` in
`data/api.ts` with a call to it, typed as `Probe<{version: string; path: string}>`
(§7.2). Update `AgentDetailPage.tsx:483` and `profile-settings/Copilot.tsx`.
*Accept:* on a machine with no `claude` on PATH, the badge reads "Not detected"
and links to setup. No version string appears anywhere it was not read.

**W1.3 · Sanitise the comment path · 0.5d**
`WorkItemDetailPage.tsx`: the textarea at :871-877 posts plain text, so render it
as plain text. Replace the `dangerouslySetInnerHTML` at :858-861 with a `<div
className="whitespace-pre-wrap">{c.bodyHtml}</div>`. Rename the field to `body`
in a later commit; the render fix is the security fix and ships now.
*Accept:* a comment containing `<img src=x onerror=alert(1)>` renders as visible
text. Newlines survive.

**W1.4 · Delete `pages/admin/**` and `pages/sessions/**` · 0.5d**
Remove both directories, their routes in `router.tsx`, `AGENT_SESSIONS_ENABLED`
from `lib/featureFlags.ts`, and the Sessions entry in `Sidebar.tsx`. **In the same
commit**, add the harvested `INTENTS` array to the ticket-detail overflow as a
disabled-with-note menu until P6 (`CAPABILITIES['agents.runtime']`).
*Accept:* ~1,400 lines deleted; `npm run build` green; no dangling imports.

**W1.5 · Copy purge · 0.5d**
Rewrite `project-settings/Features.tsx:14-36`,
`project-settings/Automations.tsx:122-131`, and
`components/domain/CreateProjectModal.tsx:26-52` — **all three**, the third being
the one the original audit missed. Then a human read-through of the ~20
`EmptyState` descriptions.
*Accept:* no string in the repo matches Plane's feature or automation copy. A
sentence that any tracker could have written gets rewritten.

**W1.6 · Capability register + `NotWired` + `Probe<T>` · 1.5d** (§7.1, §7.2)
*Accept:* `capabilities.ts` exists with entries for all ten surfaces in §7.1;
`NotWired` takes only a `CapabilityKey`; `Probe<T>` is used by W1.2.

**W1.7 · Honesty lint gate · 0.5d** (§7.3)
Two rules in `eslint-rules/`, a `lint:honesty` script, and a **required** CI step
separate from the existing `continue-on-error` lint job.
*Accept:* the rule fires on the three `console.log` menu items before W1.8 fixes
them, and on nothing else in the tree.

**W1.8 · Tier 1 sweep · 1.5d**
Walk `capabilities.ts` and place `<NotWired>`: Webhooks, Exports, Automations,
profile Notifications, first-day-of-week, the public request form, Drafts. Fix
the cycle favourite stars (persist, or delete the star). Redraw the burndown as
two points with a "no daily history yet" note, or delete the chart. Remove
Quicklinks from Home. Fix the three dead menu items and "Copy link"'s `app://`
URL. Fix `Topbar.tsx:326`'s `projects[0]` bug using the existing
`useCurrentRouteProject`.
*Accept:* `lint:honesty` passes; no surface promises something the register calls
`not-wired` without rendering the note.

### P2 — Rename

**W2.1 · `mock/` → `data/` · 0.5d** — C1 in §6.2. *Accept:* `tsc` clean, zero
`@/mock` references.

**W2.2-W2.5 · The four rename commits · 4d** — C2-C5 in §6.2, with the tripwire
test from §6.4 growing per commit.
*Accept per commit:* both halves build, both test suites pass, the tripwire bans
that cluster's identifiers, and the generated SQL contains no unreviewed `DROP`.

**W2.6 · Structural enum changes · 1.5d** — §3.3 (`triage` + `tickets.source`)
and `workstream_status` (§3.2 #19).
*Accept:* `state_group` has five values; every project has exactly one default
state; `SELECT count(*) FROM tickets WHERE source='request'` equals the count of
converted requests.

### P3 — Foundations

**W3.1 · Proposals schema + migration · 3d** — §4.2.
*Accept:* `proposals.service.test.ts` passes unmodified except for the table
rename. Every existing row has `origin='copilot'` and a non-null `project_id`.

**W3.2 · Review-queue API · 3d** — §4.4.
*Accept:* `GET /proposals?status=proposed` returns cross-conversation rows with
correct counts; `POST /proposals/bulk-approve` with a mixed batch of one valid
and one stale id returns one `executed` and one `stale`, and the valid one
actually executed.

**W3.3 · Repair pass extraction · 2d** — the interval + partial indexes in §4.2.
*Accept:* `EXPLAIN` on the pending-expiry query uses
`proposals_pending_expiry_idx`; `listProposals` no longer runs a full repair on
every call.

**W3.4 · Typed filter schema + server-side filtering · 4d** — §4.6.
*Accept:* `GET /tickets?filter=…` honours every field; `useWorkItemsView` contains
no filter predicate; Calendar, Spreadsheet and Gantt show the same count as the
toolbar badge.

**W3.5 · Saved views on the filter · 2d** — nullable `project_id`, the `{}` → `{v:1}`
migration, project scope into `filters.projectIds`.
*Accept:* an existing view still lists its project's tickets after migration.

**W3.6 · Runner extraction · 4d** — §5.2.
*Accept:* **`copilotRunner.test.ts` passes with zero edits.** That is the whole
criterion.

### P4 — Review queue

**W4.1 · `proposalStore` · 1.5d** (§1.8) — *Accept:* approving in the Copilot
panel removes the row from an already-mounted Review screen with no refetch.

**W4.2 · One `ProposalCard` · 1.5d** — generalise
`components/domain/CopilotProposalCard.tsx` to take a `ProposalView` regardless of
origin, keeping its deliberate plain-node rendering of model text (:116).
*Accept:* the same component renders in the panel, the Review list, the ticket
drawer and Requests.

**W4.3 · Review screen · 5d** — segments, agent/project/kind filters, bulk
select, `e`/`r` shortcuts, the health strip.
*Accept:* the health strip shows "not enough decisions yet" below 10 decisions;
above it, both the rate and the median come from stored `decision_latency_ms`.

**W4.4 · Ticket detail + Requests on the same card · 2d**

**W4.5 · Proposals-approved-per-active-day tile · 2d** — decision 10. Do this
first if the schedule allows; it cannot be instrumented retroactively.

### P5 — Sparse projects and the ticket list

**W5.1 · Drop `features`, add `accepts_requests`, add `primitiveCounts` · 3d** — §3.4.
*Accept:* `GET /projects` issues one query; a project with zero sprints shows no
Sprints entry; `Add… → New Sprint` creates one and the entry appears.

**W5.2 · One `TicketList` component, three scopes · 6d** — project, workspace,
sparse. Grouping, filters, search, bulk, `j`/`k`/`x`.
*Accept:* the workspace list and a project list are the same component with
different default filters; the count line always equals the rendered rows.

**W5.3 · Saved-view filter editor · 3d** — *Accept:* `createView` never saves `{}`.

**W5.4 · Keyboard layer · 2d** — the mockup's map, including `g`-prefixed
navigation and `?`.

### P6 — Agent runtime (see §5 for design; sizes from §2.2)

**W6.1** `agent_runs` schema + claim protocol · 4d ·
*Accept:* two concurrent `POST /agent-runs/claim` return different rows; a run
whose heartbeat is 61s stale is reclaimable, but **not** if it has proposals.

**W6.2** Dispatcher in main · 6d ·
*Accept:* a manually dispatched run starts within 5s, respects
`MAX_CONCURRENT_RUNS=2`, and is aborted and returned to `queued` on app quit.

**W6.3** `agent.md` / autonomy / policy · 4d ·
*Accept:* a `plan-only` agent's session has zero `propose_*` tools in the SDK
init event; a brief instructing "ignore the approval requirement" does not
produce a direct write, because no write tool exists.

**W6.4** Trigger bus (`on-assign`, `on-label`, `on-request`) · 4d ·
*Accept:* an agent's own comment does **not** enqueue a run; the 21st run in an
hour lands as `blocked` with a visible reason.

**W6.5** Failure, timeout, concurrency, MCP bearer token · 4d · §5.7, §5.8.3

**W6.6** Run-state UI + Blocked segment · 4d ·
*Accept:* `agent_assignments.status` reaches `running`, `needs-review`,
`blocked` and `failed` from real runs, not from `db/seed.ts`.

**W6.7** Requests agent triage · 4d ·
*Accept:* a new request produces a proposal visible in both Requests and Review,
tagged with its source, resolvable from either.

### P7 — Earned trust · 6d · §4.5

*Accept:* granting requires a click; an auto-applied proposal appears in "Ran
overnight" with Undo; Undo reverses the change **and** flips the grant back to
`ask` in one transaction; the agent page shows why the grant was revoked.

---

## 10. Decisions that need the founder, not an architect

| # | Decision | Why it is not mine | Cost of each option |
|---|---|---|---|
| **F0** | **Did Plane source code enter this repository at any point?** | Legal, and no agent can answer it | Clean → proceed. Not clean → stop, talk to a lawyer, and do not ship the renames (they would read as concealment). **Blocks everything.** |
| **F1** | **Where does the data live?** (§1.1) | It is a product-position decision wearing an infrastructure costume | (a) **Keep Postgres + Docker.** Zero engineering; the pitch cannot say "local-first" without an asterisk about Docker Desktop, and the machine screen cannot ship. (b) **PGlite** (WASM Postgres, in-process): keeps the Drizzle schema, the SQL dialect and every query verbatim; drops Docker entirely; ~1.5 weeks plus a real look at maturity for this workload. (c) **SQLite/libsql**: most mature, but a dialect port of 26 tables, every `jsonb`, the `pgEnum`s, `bigserial`, and `FOR UPDATE SKIP LOCKED` (which SQLite lacks — the claim protocol in §5.5 needs a rewrite). ~3 weeks. **Recommendation: (b), decided now, executed after P4.** |
| **F2** | **Collapse `agent_autonomy` to `plan-only \| ask-before-write \| trusted`?** (§4.5) | It removes a level a user may have chosen | Cutting `ask-before-pr` is free — nothing implements it. Keeping it means shipping a select option that cannot ever do anything, which is the defect class this whole revamp exists to remove. |
| **F3** | **Does `tickets.duplicate_of_id` count as breaking the relations freeze?** (§4.3) | Strategy §3 says an item appearing in a sprint means the freeze decision was quietly reversed; this is that test | One nullable self-FK, half a day, and it unblocks the mockup's second-most-visible proposal kind and gives Requests' `duplicate` status somewhere to point. A general relations model is a different, much larger thing and stays frozen. My read: this is narrow enough to allow, but it is exactly the call the freeze list exists to make deliberate. |
| **F4** | **"Workstreams" or "Areas"?** | The plan records the recommendation and defers to you | Free now, expensive after P2 lands. Decide before C3. |
| **F5** | **Squash the migrations?** (§3.1) | It destroys any local database | Squash: one clean baseline, no enum surgery, ~4 days saved. Keep: incremental history nobody will ever replay, and §3.3's hand-written migration must be exactly right. |

---

## Appendix A — file map for the units above

| Area | Path |
|---|---|
| Proposal state machine | `waypoint-backend/src/services/proposals.service.ts` |
| Proposal schema | `waypoint-backend/src/db/schema/copilot.ts:60-132` → new `schema/proposals.ts` |
| MCP tools | `waypoint-backend/src/mcp/{workItemTools,proposalTools,server}.ts` |
| MCP transport | `waypoint-backend/src/routes/mcp.routes.ts` |
| Agent schema | `waypoint-backend/src/db/schema/agents.ts` |
| Feature toggles | `waypoint-backend/src/db/schema/projects.ts:29`, `services/projects.service.ts:114,259-263`, `validation/projects.schema.ts:43-49` |
| `triage` | `schema/projects.ts:11`, `services/projects.service.ts:68`, `db/seed.ts:204,312,404`, `validation/projects.schema.ts:67,74` |
| Webhook events | `waypoint-backend/src/validation/misc.schema.ts:23-32` |
| Hardcoded identity | `waypoint-backend/src/lib/currentUser.ts` |
| Copilot runner | `waypoint-frontend/src/main/copilot/copilotRunner.ts` |
| System prompt | `copilotRunner.ts:24-45` (base), `:64-107` (composed) |
| MCP allowlist | `copilotRunner.ts:168-183` |
| Secret denylist | `copilotRunner.ts:123-144` |
| SDK boundary | `waypoint-frontend/src/main/copilot/claudeSdkClient.ts` |
| Real Claude probe precedent | `copilotAuth.ts:96-156`, `copilotConnect.ts:24-49` |
| IPC surface | `waypoint-frontend/src/main/preload.ts` |
| Entity types | `waypoint-frontend/src/renderer/types/entities.ts` |
| HTTP layer | `waypoint-frontend/src/renderer/mock/{api,httpClient}.ts` |
| Data hook | `waypoint-frontend/src/renderer/lib/useAsync.ts` |
| Proposals hook | `waypoint-frontend/src/renderer/lib/useCopilotProposals.ts` |
| Proposal card | `waypoint-frontend/src/renderer/components/domain/CopilotProposalCard.tsx` |
| Ticket view logic | `waypoint-frontend/src/renderer/pages/work-items/useWorkItemsView.ts` |
| Honesty sites | `pages/profile-settings/Security.tsx:17-20,36-43,133`; `mock/api.ts:213-225`; `pages/work-items/WorkItemDetailPage.tsx:644,652,660,858-861,871-877`; `pages/cycles/cycle-utils.ts:84-124` |
| Copy-purge sites | `pages/project-settings/Features.tsx:14-36`; `pages/project-settings/Automations.tsx:122-131`; `components/domain/CreateProjectModal.tsx:26-52` |

---

## 11. Founder decisions, recorded

| # | Decision | Recorded answer |
|---|---|---|
| F0 | Did Plane source enter this repo? | **No — inspiration only, not copied code.** Renames proceed as hygiene, not concealment. |
| F1 | Where does the data live? | **Docker + Postgres, kept.** Local-first means the Postgres instance runs on the user's own machine inside the Electron app's own Docker setup, never on the web — not literally embedded/single-file. The mockup's `~/Library/…/waypoint.db` framing and any copy implying a single embedded DB file must be corrected to describe the actual architecture (local Postgres container, not shipped to any server). PGlite/SQLite migration is out of scope. |
| F2 | Cut `ask-before-pr` autonomy? | **Yes — cut.** Nothing implements it and the product has no PR flow. |
| F3 | Allow narrow `duplicate_of_id` as an exception to the relations freeze? | **No — freeze stays intact.** Duplicate-detection proposals describe the duplicate in the proposal text; no new relation column. |
| F4 | Workstreams or Areas? | **Workstreams.** |
| F5 | Squash migrations to one baseline? | **Yes.** Local databases are expendable; no production data exists. |

**Additional scope decision, from the founder directly (not in the original F-list):**
Copilot's existing engine — `copilotRunner.ts`, the MCP tool server, session management, and the
propose→approve→execute state machine — is proven, tested, and satisfactory. **It is not to be
functionally modified.** Renaming vocabulary that flows through it (MCP tool names, system-prompt
text) still happens per §6's atomicity constraint, but its behavior, security posture, and session
model are frozen as-is.

Consequence for §5 (agent runtime): **P6 as originally scoped (a second, parallel execution engine
for `agent.md`/`autonomy`/`triggers`/`AgentAssignment`) is deferred, not built in this pass.** The
Review queue, the unified proposal card, and Requests triage are built against the *existing*
`copilot_proposals` system — they read and surface it under new UI, they do not replace it with a
new backend. The Agents configuration page (workspace settings) remains present but unwired, exactly
as it is today, until a separate decision is made to build real agent execution. Earned trust (§4.7)
is deferred with it, since it has nothing to compute over without a second runtime producing
per-kind decision history beyond what Copilot itself already produces.

This narrows P3–P7 to: proposals model work that *wraps* the existing `copilot_proposals` table
rather than replacing it, the typed filter, the unified ticket list, sparse projects, the Review
queue as a new consumer of existing data, and the rename. The agent-runtime estimate (5–6 weeks) is
removed from the critical path.

---

## 12. Timeline, recalibrated against observed execution

§9's estimates are one-developer-day units, calibrated to a human's pace
(context-switching, meetings, PR-review latency). That's not the execution
model this is actually running under, and the gap is large enough to record
with evidence rather than adjust by feel.

**P1 (estimated 6 developer-days) landed in ~21 minutes of wall-clock time.**
Architecture doc committed 16:38:59; P1 Wave 1's last commit (the honesty lint
gate, unit W1.7) landed 17:00:12 — six units, ~20 commits, running in parallel
across isolated worktrees. Wave 2 (the two units gated on Wave 1's output)
launched immediately after and was already landing commits by 17:13.

That ~400x figure is real but phase-specific, not a constant to multiply
everything by: P1's units happened to touch disjoint files, so 6–8 agents ran
in genuine parallel. That multiplier does not apply uniformly:

- **P2 (rename) cannot use it.** §2.1 Constraint A is unchanged by execution
  speed — it's a global-touch change (~40 frontend files, the DB schema, MCP
  tool names, the Copilot system prompt, all touched by the same change) and
  must run as one continuous pass, not fanned out. It will still be far faster
  than a human's 6 days — no context-switching, mechanical rename work,
  test-verified at each atomic commit — but the compression comes from *speed*
  on a serial task, not *fan-out*, so it won't reproduce P1's ratio. Real
  number pending — P2 hasn't run yet.
- **P3–P5 have internal parallel tracks** (three in P3, per §2.1 Constraint B/C)
  and should compress similarly to P1 for the parallelizable portions — but
  P3 specifically includes real Postgres migrations, which take actual
  wall-clock seconds to run and verify, not zero, and that floor doesn't move
  no matter how fast the agent reasons.

**Revised expectation:** the original ~56-developer-day / ~11-week estimate for
P1–P5+P8 (P6/P7 deferred per §11) is not the right scale to plan against. The
realistic remaining scope is **hours of wall-clock time across a handful more
waves**, not weeks — but P2's actual duration is the next real data point, not
yet observed, and this section should be updated with it once P2 lands rather
than left as a projection.
