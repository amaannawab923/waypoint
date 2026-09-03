# Rename state

The Waypoint vocabulary rename lands as five sequential commits on
`feat/waypoint-revamp`. Each one must leave `npm run build && npm test` green on
its own, so a bisect landing between any two of them still works. The full plan
is [waypoint-revamp-architecture.md §6](./waypoint-revamp-architecture.md#6-rename-execution-plan);
this file is the one-read answer to "how far has it got?".

**Update this file in the same commit that lands the work it describes.**

| # | Commit | Landed |
|---|--------|--------|
| C1 | `refactor: rename mock/ to data/` — path only, zero semantic change. `git mv src/renderer/mock src/renderer/data`, rewrite `@/mock/…` → `@/data/…`. | `[x]` |
| C2 | `refactor(db): rename work items to tickets` — backend schema + migration + routes + services + validation, **and** the renderer types/pages/routes that consume them. `WorkItem`→`Ticket`, `WorkItemState`→`TicketState`, `work-items` routes, `/work-items` URL, "Sub-work items"→"Subtasks". | `[x]` |
| C3 | `refactor(db): rename cycles/modules/intake/pages/stickies` — Sprints, Workstreams, Requests, Docs, Scratchpad. Same both-halves shape. Includes the `WorkModule.status` collapse, the `triage` state-group drop, and the `webhooks.event_types` remap. | `[x]` |
| C4 | `refactor(mcp): rename tool surface and the Copilot prompt` — `workItemTools.ts`, `proposalTools.ts`, `MCP_TOOLS`, `COPILOT_SYSTEM_PROMPT_BASE`, `copilot_proposal_kind.create_work_item`→`create_ticket`. **Atomic — see §6.1 constraint 1.** | `[x]` |
| C5 | `refactor: labels, visibility, and copy` — `Network`→`Visibility`, `Categories`→`Sizes`, `Archives`→`Archive`, `Billing and plans`→`Billing`, `Your work`→`My work`, Notifications heading, `Work Structure`→`Ticket setup`, README. | `[x]` |

## The tripwire (retired in C5)

`waypoint-frontend/src/renderer/__tests__/vocabulary.test.ts` greped the
renderer tree for abolished identifiers and failed the suite on any hit. It
existed so a session that stopped mid-cluster left a red build rather than a
plausible-looking half-rename.

Bans were added in the same commit that abolished them, and C5 deleted the
whole file, per its own stated plan — the rename it guarded is complete, so it
has nothing left to catch:

- **C1 (landed)** — banned the literal `@/mock`.
- **C2 (landed)** — added `WorkItem`, `work_item`, `work-items`.
- **C3 (landed)** — added `Cycle`, `Module`, `Intake`, `Sticky`.
- **C5 (landed)** — deleted the file. Nothing referenced it by path (no Jest/
  Vitest config named it explicitly; it was picked up by the default test
  glob), so the deletion needed no other edit.

C2 added an `allowed` field to the `Ban` type: literals that contain a banned
pattern but are legitimately still in the tree, stripped from a line before it
is tested. Allowances are precise — they exempt the literal, not the line.

C3 widened the field to cover a second kind. There are now two, and each entry
says which it is:

- **Dated** — the literal belongs to a cluster a later commit owns, and names
  that commit. Deleting the allowance is part of that commit.
- **Permanent** — the literal is a third-party identifier that merely contains
  the banned string, and names its owner. Without it the ban would silently
  forbid writing a real API's name, which is not a rule anyone could guess
  from the failure message.

| Allowance | Kind | Owned by | Delete it in |
|---|---|---|---|
| `jest.resetModules` | permanent | Jest's own API, named in a comment in `AppShell.flag-disabled.test.tsx` | never |

C3 removed C2's `work_item.created` / `.updated` / `.deleted` allowance: those
webhook event values are renamed now (§3.5).

C4 removed the `create_work_item` allowance C2 added: `copilot_proposal_kind`'s
enum value is `create_ticket` now, and so is every consumer, so the literal has
no legitimate occurrence left in the renderer tree. Verified by planting
`// planted violation: create_work_item` in a renderer file — the `work_item`
ban fired — then reverting it.

## Standing constraints

- **Do not merge C1–C5 to `main` individually.** Merge the set or none (§6.4.2).
- ~~**Regenerate `drizzle/meta` only once**, at the end of C3~~ — **done.** The
  migration history is now a single `drizzle/0000_baseline.sql`; see "The
  squash" below for what that cost and how to recover a local database.
- **Copilot's engine is frozen** — `copilotRunner.ts`, the MCP server, and the
  propose→approve→execute state machine are not to be functionally modified
  (§11). C4 renames the vocabulary that flows through them; nothing else.
- **Prose is not mechanical.** The copy purge and the Copilot system prompt are
  rewrites, not find-and-replace (§6.3).

## What C1 actually did

- `git mv waypoint-frontend/src/renderer/mock waypoint-frontend/src/renderer/data`.
- Rewrote every `@/mock/…` import in `waypoint-frontend/src` to `@/data/…`.
- Updated the comments in `waypoint-frontend/src` that named the old path, and
  the source-tree listing in `waypoint-frontend/README.md`.
- Added the tripwire test with its first ban.

No alias changes were needed: `tsconfig.json`, the `.erb/configs/webpack.*`
configs, and the Jest `moduleNameMapper` all map `@/*` to `src/renderer/*`
generically, with no path segment naming `mock`.

Comments referring to `mock/db.ts`, `mock/seed.ts`, and `src/mock/seed.ts` were
deliberately left alone — those name files in the predecessor app that do not
exist in this tree, so they are history, not paths.

## What C2 actually did

Renamed the work-item entity to **Ticket** across both halves: §3.2 items 1–7
(five tables, the eight `work_item_id` columns, and `intake_requests
.linked_work_item_id`), plus every backend and renderer identifier, route, file
and directory that named it. `intake_requests` itself is untouched — the table
rename is C3's, only its column moved here.

**The migration is a clean rename, not a drop-and-recreate.**
`drizzle/0006_sudden_james_howlett.sql` contains no `DROP TABLE` and no
`DROP COLUMN` — only `ALTER … RENAME TO` / `RENAME COLUMN`, plus the constraint
drop/re-add pairs Postgres requires because it does not rename constraints when
their table is renamed. It applied to the existing dev database in place; no
`docker compose down -v` and no reseed was needed (`db:seed` was re-run anyway,
and reports "Seeded 19 tickets across 2 projects").

Getting that took one non-obvious step. `drizzle-kit generate` **refuses** to
run its rename-vs-drop prompt without a TTY — in this version it errors out
rather than silently choosing drop, so §3's hazard 1 is less dangerous than the
doc feared, but it also means the command cannot simply be piped. Answering the
prompts by feeding newlines does not work either; the TUI ignores `\n`. What
works is driving it under a pty and selecting each rename explicitly. C3 will
hit exactly the same wall and can reuse the approach: `spawn npx drizzle-kit
generate` under `expect`, and for each "Is X table/column created or renamed
from another…?" prompt, send `\033[B` (down) until the highlighted `❯` row
reads `~ <old> › <new>`, then `\r`.

### Deliberately left alone

| Left as-is | Why | Lands in |
|---|---|---|
| `registerTool`/`withErrorSafetyNet` name strings — `get_work_item`, `list_work_items`, `search_work_items`, `get_work_item_by_identifier`, `propose_create_work_item` | §6.1 constraint 1: they must move with `MCP_TOOLS` and the prompt in one commit | C4 |
| `COPILOT_SYSTEM_PROMPT_BASE` (`copilotRunner.ts:28`) | same constraint; prose, not find-and-replace | C4 |
| `copilot_proposal_kind` value `create_work_item` | §3.2 item 18 | C4 |
| `src/mcp/workItemTools.ts` (+ `.test.ts`) filename and `registerWorkItemTools` | the MCP tool-surface identity; §6.2 lists the file under C4 | C4 |
| The `work item (ticket)` / `work items (tickets)` glosses in the two MCP files' tool `description`s | a mechanical rename emits "ticket (ticket)" — these are the same model-facing prose as the prompt and read as one rewrite with it | C4 |
| `webhooks.event_types` values `work_item.created/.updated/.deleted` and their picker labels in `Webhooks.tsx` | §3.2 item 20 / §3.5 — one data `UPDATE` alongside `cycle.*` and `module.*` | C3 |
| `sub_item_added` activity verb, and the `subItems`/`listSubItems`/`subItemStats` identifiers | none contain "work item"; §3.2's note groups the verb with C3's activity-verb data update. Only the visible labels moved here ("Sub-work items" → "Subtasks", "Add sub-work item" → "Add subtask") | C3 |
| "work items" in the root `README.md` and `waypoint-backend/README.md:4` | entity-list prose that C5 rewrites together with cycles/modules/intake | C5 |
| `page<T>` in `workItemTools.ts:77`, and `vi.mock`/ESM "module" in `copilot.routes.test.ts` and `proposalTools.test.ts` | §6.3 traps — unrelated words | never |

Everything else in `workItemTools.ts`/`proposalTools.ts` — imports, types,
internal calls, `notFoundResult('work item')`, comments — followed the rename
normally, so C2 leaves tools literally named `'get_work_item'` calling
`ticketsService.getTicket(...)`. That incongruity is expected and is precisely
what C4 exists to resolve.

### One behavioural change, and why it is part of the rename

`RecentType`'s `'work-item'` → `'ticket'` changes a value **persisted to
localStorage** under `waypoint:recents`. `readRecents()` cast the parsed JSON
without checking it, so a stale entry reached `Home.tsx`'s
`RECENT_TYPE_ICON[recent.type]` as `undefined` and rendered `<undefined />`,
taking the Home page down for anyone with existing local state. `recents.ts`
now derives `RecentType` from a runtime `RECENT_TYPES` array and filters unknown
types on read. **C3 renames `'cycle'` and `'module'` in that same persisted
union** — the guard already covers it, but the array must be updated with them.
(C3 did, and `'page'`→`'doc'` with them; see below.)

## What C3 actually did

Renamed the remaining five entity clusters across both halves: §3.2 items 8–12,
16, 19 and 20, plus the `triage` state-group drop from §3.3 and the data remaps
from §3.2/§3.5.

| From | To |
|---|---|
| `cycles` / `cycle_members` / `tickets.cycle_id` | `sprints` / `sprint_members` / `tickets.sprint_id` |
| `work_modules` / `module_members` / `tickets.module_id` | `workstreams` / `workstream_members` / `tickets.workstream_id` |
| `intake_requests` | `requests` |
| `pages` / `pages.parent_page_id` | `docs` / `docs.parent_doc_id` |
| `stickies` | `scratch_notes` |
| enum `module_status` / `page_visibility` / `intake_status` | `workstream_status` / `doc_visibility` / `request_status` |

Identifiers follow: `Cycle`→`Sprint`, `WorkModule`→`Workstream`,
`IntakeRequest`→`Request`, `IntakeStatus`→`RequestStatus`, `Page`→`Doc`,
`Sticky`→`ScratchNote`. Routes follow: `/cycles`→`/sprints`,
`/modules`→`/workstreams`, `/intake`→`/requests`, `/pages`→`/docs`, and
`/stickies`→`/scratchpad` in the renderer (the API resource is `/scratch-notes`
— the page names a place, the endpoint names the thing). `pages/cycles/`
becomes `pages/sprints/`.

`Request` deliberately shadows the DOM's global `Request` inside every module
that imports it. Nothing in this app constructs a fetch `Request`
(`httpClient.ts` uses `Response` only), and the product calls these Requests,
so the entity gets the plain name; the decision is recorded in a comment above
the interface.

`RECENT_TYPES` in `lib/recents.ts` went from `['ticket', 'page', 'cycle',
'module']` to `['ticket', 'doc', 'sprint', 'workstream']` — three renamed
values, not the two C2 predicted, since `'page'` is in the same union. These
are persisted to `localStorage` under `waypoint:recents`; C2's runtime guard
already drops unknown types on read, so a stale entry is forgotten rather than
rendering `<undefined />`. `Home.tsx`'s `RECENT_TYPE_ICON` and
`RECENTS_FILTER_OPTIONS` moved with it, and `Record<RecentType, …>` keeps the
three in step.

### The migration

`drizzle/0007_nervous_sabretooth.sql` was generated under a pty and then
hand-edited. **It contains no `DROP TABLE` and no `DROP COLUMN`** — every table
and column moves by `ALTER … RENAME`, with the constraint drop/re-add pairs
Postgres requires because it does not rename constraints with their table.

C2's pty recipe worked unchanged and is worth keeping: `drizzle-kit generate`
still errors out rather than silently choosing drop, still ignores `\n`, and
still needs `\033[B` + `\r` under `expect`. C3 answered ~18 prompts, which is
too many to drive by hand, so the script reads each prompt's printed option
list, finds the row whose old name is in a rename table, and presses Down that
many times. Two ordering facts, in case a later commit needs them: enum prompts
come before table prompts, which come before column prompts, and within each
kind the "create" row is always first with the rename candidates following in
the order the dropped objects appear in the previous snapshot.

Three blocks are hand-written, because drizzle-kit cannot express them. They
are marked `HAND-WRITTEN` in the file:

1. **The `triage` drop (§3.3) — destructive.** Adds `tickets.source`
   (`ticket_source` enum: manual/request/agent/import) and backfills
   `'request'` from `requests.linked_ticket_id` *before* anything is removed,
   because provenance was the only fact a triage state carried. Then moves
   every ticket in a triage state to its project's first `backlog` state
   (`tickets.state_id` is `ON DELETE RESTRICT`, so this is mandatory), deletes
   the triage states, rebuilds `state_group` without `'triage'` via
   rename-recreate-swap, and restores `is_default` for any project left
   without one. **Which specific triage state a ticket sat in is gone and is
   not recoverable.** On the dev database this moved one ticket (`wi-10`) and
   deleted two states.
2. **`workstream_status`, six values to five (§3.2 item 19) — destructive.**
   Same rename-recreate-swap, with the remap in the `USING` clause:
   `backlog`→`planned`, `in-progress`→`active`, `completed`→`done`,
   `cancelled`→`dropped`, `planned` and `paused` unchanged. **`backlog` and
   `planned` both land on `planned`, so that distinction is gone.** The column
   default has to be dropped before the swap and re-added after, which §3.3's
   worked example does not show because its column had none.
3. **Data-only updates.** The three activity verbs (`module_added`→
   `workstream_added`, `cycle_added`→`sprint_added`, and C2's deferred
   `sub_item_added`→`subtask_added`), the `webhooks.event_types` remap from
   §3.5 — which also finishes C2's deferred `work_item.*`→`ticket.*` — and the
   `projects.features` jsonb keys, whose names *are* the primitives
   (`cycles`→`sprints`, `modules`→`workstreams`, `pages`→`docs`,
   `intake`→`requests`).

The webhook remap uses `unnest … WITH ORDINALITY` and `COALESCE(…, ARRAY[]::text[])`:
`array_agg` over an empty array returns `NULL`, and `event_types` is `NOT NULL`,
so a webhook subscribed to nothing would otherwise fail the migration.

It applied to the existing dev database in place. Verified against seeded data
plus planted probe rows (a webhook with five old event types, an empty one, and
one activity entry per renamed verb): 29 tables before and after, the triage
group gone, `wi-10` moved to `st-l-backlog`, one workstream remapped
`backlog`→`planned` and two `in-progress`→`active`, all three verbs flipped,
both webhooks correct, both projects' feature keys renamed.

### Deliberately left alone

| Left as-is | Why | Lands in |
|---|---|---|
| Row-id prefixes `newId('cyc')`, `newId('mod')`, `newId('pg')`, `newId('sk')`, `newId('in')`, and the `cyc-1`/`mod-1`/`pg-1`/`sk-1`/`in-1` seed ids | opaque ids, not the entity name — the same call C2 made for `newId('wi')` and `'wi-1'` | never |
| `<PropertyRow label="Workstreams">` on the ticket detail sidebar — plural, for a single-select | pre-existing copy defect (it said `Modules` next to `Cycle`), not something the rename introduced | C5 |
| `copilot_proposal_kind` value `create_work_item`, the MCP tool name strings, `registerWorkItemTools`, `workItemTools.ts`, and `COPILOT_SYSTEM_PROMPT_BASE` | §6.1 constraint 1, unchanged from C2 — nothing in C3's cluster reaches them, so no call sites needed updating | C4 |
| "cycles, modules, pages, intake" in the root `README.md` and `waypoint-backend/README.md:4` | entity-list prose, which C2 already deferred as one rewrite | C5 |
| `position: sticky` / `className="sticky …"` in five view components | CSS, not the entity | never |
| ESM/Jest "module" in `CopilotConnectModal.tsx`, `AppShell.flag-disabled.test.tsx`, `claudeSdkClient.ts`, `copilot.routes.test.ts`, `proposalTools.test.ts` | §6.3 trap — unrelated word | never |
| "lifecycle" in `CopilotPanel.tsx` and `copilot.ts`, "open/close cycle" in `AppShell.test.tsx` | §6.3 trap — the word "cycle" inside an unrelated one | never |
| `function page<T>` in `workItemTools.ts:77`, and the `src/renderer/pages/` directory itself | §6.3 trap — pagination and the route-component folder, neither of which is the Doc entity | never |

Two adjacent things did change, and both are rename consequences rather than
scope creep. `StickyNote` (a lucide-react icon) is gone from the sidebar, Home
and the Scratchpad page: the icon depicts the abolished entity, and keeping it
would also have forced a permanent third-party carve-out in the tripwire. It is
`NotepadText` now. And `CopilotPanel.test.tsx`'s "Module mocks keep their call
history" comment became "Mocked modules …" — prose about ESM, not an API name,
so rewording was cheaper than an allowance.

### One judgment call worth recording

`ProjectFeatures`' keys are the primitive names, so they moved with the rename
even though §3.2's table does not list them — a `features.cycles` flag read by
a sidebar that says "Sprints" is exactly the half-rename the tripwire exists to
prevent. That needed the jsonb `UPDATE` above. §3.4 deletes the column outright
in P5a, so this is throwaway work; it is still the right state to leave the
tree in between here and there.

### The squash

Landed as its own commit, immediately after the rename, per §3.1 and §11 F5.
The eight migrations `0000_tough_dark_phoenix` … `0007_nervous_sabretooth` and
every file in `drizzle/meta/` were deleted and replaced by one
`drizzle/0000_baseline.sql`, regenerated from the schema files. It is 388 lines
of 19 `CREATE TYPE`, 29 `CREATE TABLE`, 3 `CREATE INDEX` and 49
`ALTER TABLE … ADD CONSTRAINT` — read by hand, and containing no `DROP` of any
kind, which is what you would expect once there is no prior history to diff
against. drizzle-kit names its output randomly (`0000_thick_donald_blake`); the
file and its `_journal.json` tag were renamed to `0000_baseline`, since a
baseline should say so.

**This is destructive and irreversible for local data.** Anyone with a local
database has to recreate it:

```bash
cd waypoint-backend
docker compose down -v && npm run db:migrate && npm run db:seed
```

That was run here from an empty volume: 29 tables, five state groups with no
`triage`, `wi-10` seeded with `source = 'request'` and linked from the accepted
request `in-2`, and workstream statuses `planned`/`active` only. `npm run build`
and the full suite are green in both halves after it — 224 backend tests, 399
frontend tests — and `lint:honesty` is clean.

The C3 migration itself (`0007`) is gone with the rest of the history, so its
`ALTER … RENAME` statements no longer exist anywhere. Its two destructive
blocks are described above and in the commit message that landed it; the
squash commit is the last point at which they can be read from `git show`.

### Notes for later commits

- `npm run lint` is red on `main` (~1700 prettier/a11y errors in files no
  rename touches). It is not a gate; `npm run lint:honesty` is, and is clean.
- `waypoint-backend` needs Node 22 — its vitest/rolldown build fails on Node 18
  with `node:util` has no export `styleText`. `.nvmrc` pins 22 in the frontend
  only.
- `CopilotPanel.test.tsx` flaked once under full-suite load and passed in
  isolation and on re-run; it is timing-sensitive, not rename-related.
- Test fixture ids (`'wi-1'`) and the `WI-42` identifier example in an MCP tool
  description were left alone — those are per-project identifier prefixes, not
  the entity name.

## What C4 actually did

Renamed the MCP tool surface, the Copilot system prompt, and the
`copilot_proposal_kind.create_work_item` enum value, per §6.1 constraint 1 and
§6.2's C4 row — the three atomicity-critical surfaces landed in one commit.

| From (`registerTool` / `withErrorSafetyNet`) | To |
|---|---|
| `list_work_items` | `list_tickets` |
| `get_work_item` | `get_ticket` |
| `get_work_item_by_identifier` | `get_ticket_by_identifier` |
| `search_work_items` | `search_tickets` |
| `propose_create_work_item` | `propose_create_ticket` |

`list_comments`, `list_activity`, `list_states`, `list_members`,
`list_projects`, `propose_comment`, `propose_state_change`,
`propose_assignee_change`, and `propose_priority_change` did not contain
"work_item" and were unaffected — their cross-references to the renamed tools
(e.g. `list_states`'s description pointing at `list_work_items`) were updated
anyway, since a stale cross-reference in model-facing prose is exactly the
"ticket (ticket)" class of tell §6.3 warns about.

### The tool-name set comparison

Extracted independently from three sources and diffed — see the commit's own
handoff for the exact commands. All three agree, 14 tools, no drift:

```
get_ticket
get_ticket_by_identifier
list_activity
list_comments
list_members
list_projects
list_states
list_tickets
propose_assignee_change
propose_comment
propose_create_ticket
propose_priority_change
propose_state_change
search_tickets
```

`registerTool(...)` names, `withErrorSafetyNet(...)` names, and `MCP_TOOLS` in
`copilotRunner.ts` (stripped of the `mcp__waypoint__` prefix) are all
byte-identical sets. Also verified live: a real `@modelcontextprotocol/sdk`
`Client` against the running backend (`docker compose`'s Postgres, the built
server on a scratch port) returned exactly this same 14-name list from
`tools/list`, and a live `list_tickets` call returned real seeded rows —
proving the registered names, not just the source text, agree with what
`MCP_TOOLS` grants.

### The prompt rewrite

`COPILOT_SYSTEM_PROMPT_BASE`'s only vocabulary-bearing clause was "You can
look up, list, and search work items (tickets), their comments, and their
activity history via tools" — now "You can look up, list, and search
tickets, their comments, and their activity history via tools". The
parenthetical gloss existed only because the model-facing name and the
registered tool name disagreed (C2 left tools literally named
`get_work_item` calling `ticketsService.getTicket`); now that both say
"ticket", the gloss has nothing left to reconcile and is gone rather than
mechanically becoming "tickets (tickets)". No other clause in the base prompt
named the old entity. The two MCP files' tool `description` strings got the
same treatment — every `work item (ticket)` / `work items (tickets)` gloss
dropped to plain `ticket` / `tickets` — since these are the same model-facing
prose the architecture doc treats as one rewrite with the prompt.

### The enum migration

`drizzle-kit generate`'s default output for this one-value enum rename was
destructive — `DROP TYPE` + `CREATE TYPE` with a `USING "kind"::"..."` cast
that fails for any existing row still holding the text `create_work_item`,
since that label no longer exists in the rebuilt type. Hand-written instead,
per §3.2 item 18 and the founder's decisions: `drizzle/0001_needy_tomorrow_man.sql`
contains one statement, `ALTER TYPE "copilot_proposal_kind" RENAME VALUE
'create_work_item' TO 'create_ticket';`, which relabels the enum without
touching any row's data. `meta/0001_snapshot.json` (generated normally, then
left alone — only the SQL needed hand-editing) diffs against `0000_snapshot.json`
in exactly two places: the id/prevId pair drizzle-kit stamps on every
snapshot, and the one enum label. Applied to the existing dev database in
place via `npm run db:migrate` — no `docker compose down -v` and no reseed
needed, since there were zero `copilot_proposals` rows to migrate on this
checkout; `pg_enum` was verified post-migration to carry `create_ticket` and
not `create_work_item`.

### File identity

`waypoint-backend/src/mcp/workItemTools.ts` (+ `.test.ts`) → `ticketTools.ts`
via `git mv`; `registerWorkItemTools` → `registerTicketTools`. Every import,
call site, and comment naming either was updated — `proposalTools.ts`,
`server.ts`, `tickets.service.ts`, and both test files.

### Deliberately left alone

| Left as-is | Why | Lands in |
|---|---|---|
| `function page<T>` in `ticketTools.ts` (formerly `workItemTools.ts:77`) | §6.3 trap — pagination, not Docs | never |
| `docs/qa/copilot-mcp-manual-test-plan.md`'s tool-name references (`list_work_items`, `get_work_item`, `search_work_items`, `propose_create_work_item`) | a QA runbook, not source or a design doc; C2/C3 left it untouched despite renaming the entities it describes elsewhere, so it was already out of the established rename scope before C4 — flagged separately rather than folded in here | unscheduled |
| `docs/design/waypoint-differentiation-audit.md`, `waypoint-defingerprinting-plan.md`, `copilot-v3-codebase-grounding.md` | historical planning/audit docs, same treatment as this file's own past-tense sections — frozen record, not live reference | never |
| Test fixture ids (`'wi-1'`) in the MCP test files | per-project identifier prefixes, not the entity name — same call C2/C3 made | never |

### Verification

`npm run build && npm test` green in both halves (224 backend tests, 399
frontend tests — one `CopilotConnectModal.test.tsx` timing flake under
full-suite load, same class as C3's noted `CopilotPanel.test.tsx` flake;
passed in isolation and on a full re-run). `lint:honesty` clean. The
vocabulary tripwire is green with the `create_work_item` allowance removed,
and was verified to actually fire: planting `create_work_item` in a renderer
file failed the `work_item` ban with the expected message, then passed again
once reverted.

## Deferred to C5

- `<PropertyRow label="Workstreams">` copy defect (C3's finding).
- "cycles, modules, pages, intake"/"work items" entity-list prose in the root
  `README.md` and `waypoint-backend/README.md:4` (C2/C3's finding).
- The label/visibility/copy cluster itself: `Network`→`Visibility`,
  `Categories`→`Sizes`, `Archives`→`Archive`, `Billing and plans`→`Billing`,
  `Your work`→`My work`, the Notifications heading, `Work Structure`→`Ticket
  setup`.
- Delete `vocabulary.test.ts` once C5 lands (§6.4's tripwire is scoped to
  land through C5, not survive it).

Nothing from C4's own cluster was deferred — see "Deliberately left alone"
above for the (non-rename) exceptions.

## What C5 actually did

Renamed the last vocabulary cluster — visibility — plus the labels and copy
deferred above, deleted the tripwire, and closed out P2.

### The DB rename was smaller than §3.2 items 13–17 describe

Before touching anything, the actual schema was checked against architecture
§3.2's five-item table (items 13–17), because C3's own "What C3 actually did"
table (above) already lists `page_visibility`→`doc_visibility` and
`intake_status`→`request_status` alongside `module_status`→`workstream_status`
— which C3's prose says is item 16, without saying anything about 15 and 17.
The schema settles it: `waypoint-backend/src/db/schema/requests.ts` already
declared `pgEnum('request_status', …)` and `docs.ts` already declared
`pgEnum('doc_visibility', …)` going into this commit, and
`drizzle/0000_baseline.sql` already has `CREATE TYPE "request_status"` and
`CREATE TYPE "doc_visibility"` — both enum types were renamed as a natural
side effect of C3 renaming the `requests` and `docs` tables that own them,
even though the architecture doc's item list scoped that pair to C5.

So C5's actual database work was items 13 and 14 only:

| From | To |
|---|---|
| column `projects.network` | `projects.visibility` |
| enum type `network` | `visibility` |

`saved_views.visibility` — the second column that shares the `network` enum
type per §3.2's note — was left untouched, exactly as instructed: its column
was already named `visibility`, only the type it references moved underneath
it (`waypoint-backend/src/db/schema/views.ts`'s import changed from
`networkEnum` to `visibilityEnum`; the column definition itself did not
change).

### The migration

Both the enum-type rename and the column rename came back from
`drizzle-kit generate` as true renames, not drop+recreate, so neither needed
hand-writing. The C2/C3 pty recipe was reused unchanged — `expect` driving the
prompts, `\033[B` (down) to select the `~ network › visibility` row, `\r` to
confirm — and this time it was only two prompts (one enum, one column), so no
prompt-counting script was needed, just two fixed sends.
`drizzle/0002_nappy_ultimo.sql` is two lines, no `DROP` of any kind:

```sql
ALTER TYPE "public"."network" RENAME TO "visibility";
ALTER TABLE "projects" RENAME COLUMN "network" TO "visibility";
```

`meta/0002_snapshot.json` diffs against `0001_snapshot.json` in exactly the
expected places: the id/prevId pair, the `network`→`visibility` column
definition on `projects`, and the `public.network`→`public.visibility` enum
definition. Applied to a from-empty database via
`docker compose down -v && npm run db:migrate && npm run db:seed` as part of
this commit's own verification (see below); `npm run db:generate` after that
reports no further changes, confirming the schema and the migration history
agree.

### Labels and copy

| Location | From | To |
|---|---|---|
| `Sidebar.tsx` nav | `Archives` | `Archive` |
| `Sidebar.tsx` nav, `YourWork.tsx` h1 | `Your work` | `My work` |
| `WorkspaceSettingsLayout.tsx` nav, `Billing.tsx` h2 | `Billing and plans` | `Billing` |
| `ProjectSettingsLayout.tsx` nav group | `Work Structure` | `Ticket setup` |
| `Estimates.tsx` preset label (the `categories` estimate type) | `Categories` | `Sizes` |
| `project-settings/General.tsx` field label | `Network` | `Visibility` |

The `EstimateType` value itself (`'points' \| 'categories'`) and every
identifier built on it — the zod enum in `projects.schema.ts`, the
`ESTIMATE_PRESETS` record key — were left as `categories`. Only the
human-facing `label` string changed. This is copy, not a data-model rename:
nothing in §3.2's item list touches the estimate system, the value is
project-scoped `jsonb` rather than a column or enum type, and renaming the
key would have meant migrating every project's stored `estimate.type`, which
nobody asked for.

**The Notifications/Inbox mismatch.** `Topbar.tsx`'s bell button carries
`aria-label="Notifications"` and no tooltip; `pages/Notifications.tsx`
rendered an `<h1>` reading `Inbox`. `pages/profile-settings/Notifications.tsx`
— the other file of that duplicate pair the architecture doc's §6.3 flags —
already read `Notifications` on its own heading. Fixed by changing the page
heading to `Notifications`, matching the nav trigger and the other file,
rather than changing the nav to `Inbox`; nothing else in the app called this
page or feature "Inbox".

**The Workstream(s) defect**, first spotted by C3: `TicketDetailPage.tsx`'s
sidebar `<PropertyRow label="Workstreams">` sits over a single-select
dropdown (`currentWorkstream?.name ?? 'No workstream'`, an "add" affordance
for exactly one). Changed to singular `label="Workstream"`.

### README

Rewrote the entity-list prose C2 and C3 both deferred: the root `README.md`'s
opening paragraph, its "What's in the box" bullets, and its screenshot
captions; `waypoint-backend/README.md`'s one-line description. `work items` →
`tickets`, `cycles` → `sprints`, `modules` → `workstreams`, `pages` → `docs`,
`intake` → `requests`, throughout, rewritten as prose rather than
find-replaced (the "Ticket tracking" bullet's "sub-items" also became
"subtasks" to match C2, which the deferred text had missed).

**Left alone, flagged rather than fixed:** the screenshot files in
`docs/screenshots/` are still named `work-item-detail.png`, `work-items.png`
and `cycles.png`, and the images themselves are unverified — they may still
show pre-rename UI copy, since renaming vocabulary in source does not
retroactively update a captured screenshot. Renaming the files without
knowing whether their pixel content matches the new copy would trade one
inconsistency for another, and regenerating screenshots is outside a
labels-and-copy commit. The README's alt text and captions now say `ticket`/
`sprint`, which reads as slightly ahead of the (unchanged) filenames. Left
for a follow-up that can actually regenerate the images.

### Verification

`npm run build && npm test` green in both halves. `docker compose down -v &&
npm run db:migrate && npm run db:seed` succeeded from an empty volume with
`0002_nappy_ultimo.sql` applied; the full suite was re-run against that fresh
database and stayed green. `lint:honesty` clean. The vocabulary tripwire was
green immediately before its own deletion (all eight bans, zero hits), and
`waypoint-frontend/src/renderer/__tests__/vocabulary.test.ts` no longer
exists; nothing referenced it by path, so no config needed updating.

## P2 closed — final whole-rename sanity pass

C5 is the last of the five sequential rename commits (§6.2), so before
closing this file out, the full C1–C5 diff was re-checked for coherence, not
just C5's own slice — see this commit's own handoff for the exact grep and
the full triage of every hit. Anything found there that reads as leftover
rename debt from an earlier commit (as opposed to one of the already-
documented "deliberately left alone" exceptions above) is called out in that
handoff for a decision before this branch moves on to P3; it is not silently
fixed or silently ignored here.

## Closing summary

All five commits are landed: C1 (`mock/`→`data/`), C2 (work items→tickets),
C3 (cycles/modules/intake/pages/stickies→sprints/workstreams/requests/docs/
scratch notes), C4 (the MCP tool surface and Copilot prompt), C5 (labels,
visibility, and copy). `npm run build && npm test` is green in both halves
after each commit, per the bisect requirement in this file's opening
paragraph, and the vocabulary tripwire caught zero half-renamed states across
the whole sequence.

This file's job is essentially done. It stays in the tree as the historical
record of how the rename actually happened — the per-commit "What N actually
did" sections, the destructive-migration notes, the deferred-item tables —
but no further commits are expected against it: there is no C6, the "Landed"
column above is complete, and the tripwire it used to track is deleted. A
later reader should treat everything above this point as frozen history, the
same way this file already treats `waypoint-differentiation-audit.md` and
`waypoint-defingerprinting-plan.md`.
