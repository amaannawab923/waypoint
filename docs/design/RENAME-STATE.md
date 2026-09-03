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
| C4 | `refactor(mcp): rename tool surface and the Copilot prompt` — `workItemTools.ts`, `proposalTools.ts`, `MCP_TOOLS`, `COPILOT_SYSTEM_PROMPT_BASE`, `copilot_proposal_kind.create_work_item`→`create_ticket`. **Atomic — see §6.1 constraint 1.** | `[ ]` |
| C5 | `refactor: labels, visibility, and copy` — `Network`→`Visibility`, `Categories`→`Sizes`, `Archives`→`Archive`, `Billing and plans`→`Billing`, `Your work`→`My work`, Notifications heading, `Work Structure`→`Ticket setup`, README. | `[ ]` |

## The tripwire

`waypoint-frontend/src/renderer/__tests__/vocabulary.test.ts` greps the renderer
tree for abolished identifiers and fails the suite on any hit. It exists so a
session that stops mid-cluster leaves a red build rather than a plausible-looking
half-rename.

Bans are added in the same commit that abolishes them, and the whole file is
deleted in C5:

- **C1 (landed)** — bans the literal `@/mock`.
- **C2 (landed)** — adds `WorkItem`, `work_item`, `work-items`.
- **C3 (landed)** — adds `Cycle`, `Module`, `Intake`, `Sticky`.
- **C5** — delete the file.

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
| `create_work_item` | dated | the `copilot_proposal_kind` enum value | C4 |
| `jest.resetModules` | permanent | Jest's own API, named in a comment in `AppShell.flag-disabled.test.tsx` | never |

C3 removed C2's `work_item.created` / `.updated` / `.deleted` allowance: those
webhook event values are renamed now (§3.5).

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
