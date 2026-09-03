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
| C2 | `refactor(db): rename work items to tickets` — backend schema + migration + routes + services + validation, **and** the renderer types/pages/routes that consume them. `WorkItem`→`Ticket`, `WorkItemState`→`TicketState`, `work-items` routes, `/work-items` URL, "Sub-work items"→"Subtasks". | `[ ]` |
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
- **C2** — add `WorkItem`, `work_item`, `work-items`.
- **C3** — add `Cycle`, `Module`, `Intake`, `Sticky`.
- **C5** — delete the file.

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
