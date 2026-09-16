# 004 — What actually gates a Product Hunt launch

**Status:** gap list as of 2026-09-14, verified against the tracker and the
build config, not assumed. "The rest of the features are complete and
polished" is not yet true; this is the distance between that sentence and
the record.

## 1. The blocker that is independent of accounts/teams

**The packaged desktop app does not open on its own.** Verified:
`waypoint-frontend/package.json` `extraResources` bundles only
`./assets/**` and `./engine/**`; nothing in `src/main/bootstrap` starts a
backend or a database. Today the app only works because a docker-compose
backend is already running at `localhost:14000` in a terminal. A Product
Hunt visitor downloads the `.app`, opens it, and the native ticket board
has no data layer.

AT1 does **not** fix this — AT1 is the hosted path; Personal must work
fully offline with zero setup. This needs its own ticket and ships first.
(Under 001 §3 Version B this blocker changes shape — it becomes "sign in
first" — but does not go away.)

The bar to match is Obsidian/Raycast, and the sibling emdash project on
this machine already does it: SQLite via Drizzle, bundled in the app, no
external service.

## 2. Known bugs on the board, not started

| Ticket | State | Why it gates launch |
|---|---|---|
| ROAD-131 (urgent) | Backlog | Outbound env-scrub gap — credential leakage for API-key-authed users; push-URL/fetch-URL mismatch. Security-relevant. |
| ROAD-132 (urgent) | Backlog | ReDoS in the verdict parser; an unknown verdict passes through silently. |
| ROAD-128, 129, 130 | Backlog | W1–W4b review follow-ups: engine timeouts, stale-lock race, orphan-on-stop, auto-approve ignoring isolation. |

Treat 131 and 132 as launch-blocking, not routine backlog.

## 3. The Jira write work that was asked for and never ticketed

Plan file: *"My Jira: complete end-to-end write functionality."* Written,
zero tickets, zero commits. It covers:
- **New:** change priority, reassign (incl. Unassign), download/upload
  attachments.
- **Fix, live-QA-confirmed:** a real Jira @mention leaks the raw Atlassian
  account ID (JIRA-87/88, fix = read comments via API v3); comment list
  shows the oldest 100, not the newest (JIRA-86); the transition popover
  is unreachable by keyboard (JIRA-159).
- **Shared:** extract `useFloatingPanel` before adding two more pickers
  that would otherwise copy-paste the same Escape bug.

Jira is the hook (002 §5). Shipping it with a mention leak and only two
of five writes is not "complete."

## 4. Copy that is currently false

`onboarding-final.html` step 6: *"Self-hosting is available today for
compliance and data-residency needs, same Docker Compose."* The tech
lead's architecture doc §8 verified the compose file is single-tenant
with no auth. True for Personal only. Either scope the copy to that until
AT2–AT4 land (001 §4 step 2), or don't ship the line.

## 5. The accounts/teams epic itself

ROAD-134 with AT1–AT6 (ROAD-135–140), all Backlog. Reorder per 001 §4:
AT2 → AT3 → AT4 → (AT5 any time) → AT1 → AT6. Bounded seat cap (002) is
added to AT6's scope.

## 6. The honest bar

If all of the above lands — the app opens by itself, Jira does what it
claims with no known bugs, teams and billing are live, self-hosting copy
is true, 131/132 fixed — plus a polish pass, that is a legitimate Product
Hunt launch. Not a demo. Nothing on this list is a research question; it
is all build.
