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
| C3 | `refactor(db): rename cycles/modules/intake/pages/stickies` — Sprints, Workstreams, Requests, Docs, Scratchpad. Same both-halves shape. Includes the `WorkModule.status` collapse and the `webhooks.event_types` remap. | `[ ]` |
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
- **C3** — add `Cycle`, `Module`, `Intake`, `Sticky`.
- **C5** — delete the file.

C2 added an `allowed` field to the `Ban` type: literals that contain a banned
pattern but belong to a later commit, stripped from a line before it is tested.
Allowances are precise (they exempt the literal, not the line) and each one
names the commit that deletes it. The two live allowances are on `work_item`:

| Allowance | Owned by | Delete it in |
|---|---|---|
| `create_work_item` | the `copilot_proposal_kind` enum value | C4 |
| `work_item.created` / `.updated` / `.deleted` | `webhooks.event_types` values | C3 |

## Standing constraints

- **Do not merge C1–C5 to `main` individually.** Merge the set or none (§6.4.2).
- **Regenerate `drizzle/meta` only once**, at the end of C3, and read the emitted
  SQL by hand for `DROP TABLE`/`DROP COLUMN` before running `db:migrate`
  (§6.4.4).
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
