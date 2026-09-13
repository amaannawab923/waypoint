# W5c · Board-shaped outcomes

Status: built 2026-09-13 on `feat/road-126-w5b-jira-dispatch` (PR #63),
the three items the PM's W5b review named as the path from 7 to 8
(`docs/product/pm-review-w5b-jira-walkthrough.md` §5): a comment written
for the board, a state change that says what the session concluded, and
an edit before the post. Companions: W5a (`w5a-investigate-fix.md`) and
W5b (`w5b-jira-dispatch.md`), whose rules stand unchanged — Copilot is
the PM, the session is the engineer, nothing reaches a tracker except as
a proposal a person approves.

## 0. Why

The W5b walkthrough put two sessions' reports on a real Jira issue and
the PM read them as a tech lead would: a wall of file paths on a board
whose readers are not engineers; a Fix that said "not pushed" beside the
host's own line saying the PR was open; an Investigate that concluded
*by design* and was followed by Waypoint proposing In Progress anyway;
and a card whose only two answers were post-it-all or throw-it-away.
Each of those is the loop working and the product not yet speaking the
board's language.

## 1. The report contract

The brief (`runs/briefs.ts`) asks every session to end its turn in one
shape, and `runs/report.ts` reads it back leniently:

```
Verdict: <one word>
## Summary
<three to eight lines for the ticket's readers>
## Details
<everything else: evidence, files and lines, what was tried, how it was verified>
```

- Investigate's verdicts: `root-cause` · `not-a-bug` · `needs-info`.
  Fix's: `fixed` · `partial` · `not-a-bug` · `wont-fix` · `needs-info`.
  *Something else…*: `done` · `partial` · `needs-info`.
- A missing verdict is the verb's default (Investigate → root cause
  found, Fix → fixed); a missing Summary heading means the first
  paragraphs up to a Details-like heading or a rule, else the first 14
  lines, bounded.
- A writing session is told **Waypoint pushes the branch and opens the
  pull request itself** and must not say the branch was not pushed —
  the host adds those facts, and a session cannot contradict a line it
  did not write.

## 2. What lands on the ticket

`runs/runComment.ts` builds the comment from facts the host holds, in
this order, and never the Details:

```
**Verdict:** fixed

<the Summary>

Branch `agent/ENG-77` from `main` · 2 commits · 3 files changed
Pull request: https://github.com/o/r/pull/64

_Full report — the evidence, files and how it was verified — is on the run in Waypoint (ENG-77 · Fix)._
```

The branch line is git's count through the hardened runner (commits,
files, uncommitted changes); the listing itself is the PR body's (W6).
A failed publish is the host's sentence; a closing verdict is
*Not published: the session's verdict was won't fix*. The Details stay
with the run: its transcript (ROAD-124) and the PR body.

## 3. What the verdict decides

`statePlanFor(run, verdict)` in `runs/finalize.ts`:

| verb · verdict | proposes |
| --- | --- |
| Fix · fixed / partial | the review state (W5a: named review, else last started) / the review transition (W5b) |
| Fix or Investigate · not-a-bug / wont-fix | the closing state — a `cancelled`-group state named for closing, else the first `cancelled`-group state; on Jira a transition whose target is named for closing (Won't Do, Cannot Reproduce, Closed…), else the first *done*-category transition |
| anything · needs-info, Investigate · root-cause, *Something else…* | nothing; the comment alone |

A closing verdict is **not published**: a won't-fix pull request is
noise for the team, and the branch stays in the worktree. The verdict is
written on the run (`agent_runs.verdict`, migration 0020), named in the
Copilot note, and shown as a chip on the session row and header. A
project or issue that offers no fitting state is a `note` event naming
what it did offer — never Done for a not-a-bug.

## 4. Copilot knows the history

`dispatch_session` reads the ticket's runs from the ledger and hands the
renderer, and tells the model, how many there were and what the latest
concluded: *2 earlier runs · latest: Fix, needs review, verdict: not a
bug*. The offer card shows that line with a link to the run; the system
prompt says a closing verdict means Waypoint already proposed closing
the ticket, so the model says that instead of offering a Fix. `get_run`
reports the verdict and the PR.

## 5. Edit before posting

`PATCH /copilot/proposals/:id {body}` edits a `comment` still `proposed`
— never a state change, a stale card, or one that has moved. The first
edit keeps the agent's original beside the new body (`originalBody`)
and every edit stamps `editedAt`; a run's trail gets a note. The card's
pending footer offers **Edit**; the draft replaces the preview; **Save**
goes through the shared proposal store so every surface re-renders;
the card then reads *edited before posting*, with the original on
hover. The disclosure is unchanged: it is still the agent's proposal,
posted by the person who edited and approved it.

## 6. Also fixed from the W5b QA round

- JIRA-SESS-12: an ambiguous key's refusal was hidden behind the key
  menu and carried `LedgerRequestError:`. The refusal takes the menu's
  place until the next keystroke; the IPC unwrap strips any error class
  name.
- Escape with the slash menu open dropped the typed key *and* closed
  the panel; the menu now takes the keystroke.

## 7. Tests

`report.test.ts` (the shape, leniently), `runComment.test.ts` (the
comment from facts), `finalize.test.ts` (verdict → state, publish
skipped on a closing verdict, the Jira closing transition, a project
with no cancelled group), `sessionTools.test.ts` (history on the offer
and in the reply), backend `proposals.edit.service.test.ts` and the
routes, `CopilotProposalCard.test.tsx` (Edit/Save/Cancel, refusals),
`CopilotPanel.test.tsx` (history line; JIRA-SESS-12), `SessionDetail`
(the verdict chip).
