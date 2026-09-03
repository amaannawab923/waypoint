# Waypoint de-fingerprinting plan

Status: execution plan. Supersedes the legal/optics half of
`waypoint-differentiation-audit.md`. The product half now lives in
`waypoint-product-strategy.md`.

**Scope of this document:** make Waypoint stop looking like a rename of Plane.
That is a hygiene job, not a product job, and this document deliberately contains
no product argument. If you find yourself deciding what Waypoint *is* while
reading this, you are in the wrong file.

**Size:** one weekend. The original audit proposed four phases over ~4–6 weeks
with webhook back-compatibility windows and a migration plan. That was advice for
a mature product. This repo is 13 days old (first commit 2026-08-21, ~301
commits) with no users, no external webhook consumers, and no deployed database
worth migrating. Everything below is one branch and one merge.

---

## 0. The question that must be answered first — and not by me

**Plane is licensed AGPL-3.0.** The original audit rated "copied UI prose" as
High risk and ran a nine-row risk table without ever naming the license of the
product it says was copied. That is the single largest analytical gap in the
prior work, and it inverts the priority order of everything below.

The question is not "is this prose copied." Short functional UI strings are weak
copyright subjects and renaming them is cheap either way. The question is:

> **Did any Plane source code — files, functions, schema definitions, migration
> files, component implementations — enter this repository at any point, or was
> this design-read from plane.so, docs.plane.so, and screenshots?**

Why it changes everything:

- **If no Plane code was ever copied**, then what remains is convergent design
  plus some borrowed copy. Exposure is low, the work in this document is
  reputational hygiene, and it can be done calmly.
- **If Plane code was copied**, AGPL-3.0 is the strongest copyleft in common
  use, the obligations attach to the derived work regardless of what the strings
  say, and none of the renames in this document address the actual problem.
  Renaming would be worse than useless — it would look like concealment.

**How to answer it (an hour of work, for the founder, not for an agent):**

1. Search the full git history, not just the working tree, for Plane-origin
   artifacts: `git log --all --diff-filter=A --name-only` and look for files that
   arrived fully-formed; `git log --all -S'makeplane'`, `-S'plane.so'`,
   `-S'AGPL'`.
2. Check `package.json` / `pnpm-lock.yaml` history for any `@plane/*` package that
   was ever installed.
3. Check for a vendored or deleted directory containing Plane source.
4. Compare `waypoint-backend/src/db/schema/**` against Plane's Django models for
   verbatim column definitions rather than merely matching names. Matching
   *names* is what this document addresses; matching *definitions* is a different
   finding.

**I am not qualified to answer this and neither is any agent. If the answer to
step 1–4 is anything other than a clean "nothing," stop and talk to a lawyer
before shipping the renames.** This document assumes a clean answer. If that
assumption is wrong, discard it.

One related correction to the prior audit while we are here: the audit's Appendix
B listed "are the exact strings currently live in Plane's product?" as an open
`[unverified]` question and then rated the finding **High** anyway. Rate findings
at the confidence you actually have.

---

## 1. Copy purge — do this first, unconditionally

This is the only part of the plan that stands on its own regardless of the answer
to §0, because the copy is mediocre on its own merits.

### 1.1 The three known locations

| File | Lines | What |
|---|---|---|
| `pages/project-settings/Features.tsx` | 14–36 | Five feature descriptions |
| `pages/project-settings/Automations.tsx` | 122–131 | Two automation descriptions |
| `components/domain/CreateProjectModal.tsx` | **26–52** | **The same five descriptions again** |

**The third location is new — the prior audit missed it.** `CreateProjectModal`'s
`FEATURE_ROWS` array carries the identical strings a second time:

```
'Timebox work per project and adjust the time period as needed. One cycle can be 2 weeks, the next 1 week.'
'Organize work into sub-projects with dedicated leads and assignees.'
'Let non-members share bugs, feedback, and suggestions; without disrupting your workflow.'
```

The audit routed this file to Appendix A under *rename* (feature row labels), not
to the copy purge. That means the purge as originally written would have left the
copied prose live in the project-creation flow — the very first screen a new user
sees. **This is the single concrete error the senior review caught in the prior
work, and it is the reason this document exists as a separate artifact: mixing
legal hygiene into a 1,000-line product audit is how a location gets lost.**

Note that §4 of the product strategy deletes the feature-toggle grid entirely,
which removes both `Features.tsx` and `FEATURE_ROWS`. **Do not wait for that.**
Rewrite the strings now; delete the surfaces later. A purge that depends on a
product decision is not a purge.

### 1.2 The sweep

Every `EmptyState` description and every settings subtitle in
`pages/**` needs one read-through by a human with Plane open in a second window.
There are roughly twenty. This is the part that cannot be delegated to a grep.

### 1.3 The voice test

Rewritten copy should fail an "is this Plane's sentence with a word swapped"
test by being *about Waypoint's product*. "Organize work into sub-projects with
dedicated leads and assignees" is a sentence any tracker could have written.
"A workstream is a standing area of the codebase — the payments client, the
importer — that outlives any one sprint" is a sentence only this product writes.

---

## 2. The rename batch

Founder's decision, taken as given: the **neutral** column, plus **Ticket** for
the work item.

| # | Current | New | Note |
|---|---|---|---|
| 1 | Work item | **Ticket** | §2.1 |
| 2 | Cycles | **Sprints** | §2.2 |
| 3 | Modules | **Workstreams** | §2.3 |
| 4 | Intake | **Requests** | Names the artifact, not the process |
| 5 | Pages | **Docs** | |
| 6 | Stickies | **Scratchpad** | **Changed from "Notes" — §2.4** |
| 7 | Your work | **My work** | |
| 8 | Network *(field + label + filter)* | **Visibility** | Highest evidence-value-per-hour item in the table |
| 9 | Estimates → Categories | **Sizes** | UI already renders XS–XXL |
| 10 | Sub-work items | **Subtasks** | |
| 11 | Billing and plans | **Billing** | |
| 12 | Archives | **Archive** | Singular reads better. See §2.5 |
| 13 | Analytics | **Analytics** *(keep)* | **Reverted — §2.6** |
| 14 | Views | **Views** *(keep)* | Generic across the category; the problem is structural, see §2.7 |
| 15 | Drafts | **Drafts** *(keep)* | Generic |
| 16 | Spreadsheet / Gantt *(layouts)* | **keep** | Plane now uses Table / Timeline; renaming would *increase* collision |
| 17 | Notifications heading "Inbox" | **Notifications** | Fixes an internal inconsistency and a Plane match at once |
| 18 | `WorkModule.status` six values | `planned \| active \| paused \| done \| dropped` | Tightest data-model match in the audit; independently fixable |
| 19 | Triage *(state group)* | **remove** | Should never have been a sixth group |
| 20 | `ProjectFeatures` type | **delete** | See product strategy §4 |
| 21 | Webhook events, MCP tool names, activity verbs, group-by labels, search groups, Recents filters, placeholders | follow 1–5 | Mechanical |

Rename #21's MCP tool names (`list_work_items` → `list_tickets`, etc.) are read
by the Copilot runner's own system prompt in
`waypoint-frontend/src/main/copilot/copilotRunner.ts`. **Those two files must
change in the same commit or the agent breaks.**

**Deliberately not renamed:** Workspace, Project, Members, Labels, States,
Priority and its five values, Assignees, Comments, Activity, Estimates,
Automations, Webhooks, Exports, List, Board, Calendar, Home, Projects, Settings.
These are the shared vocabulary of the category. A tool that renames "Assignee"
is not differentiated, it is annoying.

### 2.1 On "Ticket" — keeping it, but for a better reason than was given

The prior audit justified Ticket by saying the agent surfaces already use it.
The senior review correctly points out that this is an argument for
*consistency*, not for the right word, and that the equally valid fix was
changing the three agent surfaces instead. That is fair, and the original
justification was weak.

The real argument: the alternatives are worse.

- **"Issue"** is the headline noun of GitHub, Linear and Jira simultaneously.
  Trading Plane's post-rename noun for the three largest incumbents' noun is not
  an improvement in fingerprint terms and is a large loss in searchability
  ("Waypoint issues" returns bug reports about Waypoint).
- **"Task"** collides with Asana, Todoist, Things and Notion, and reads too small
  for a P0 incident.
- **"Ticket"** does carry ITSM connotation (Zendesk, ServiceNow, JSM). That is a
  real cost. It is also the word every engineer actually says out loud —
  "what ticket is this on" — in teams that have never touched ServiceNow. The
  connotation costs less than the collision does.

Keeping the word the agent surfaces already speak is then a tiebreak, not the
argument.

### 2.2 On "Sprints" — the senior review is right about the collision and wrong about why it matters

The review's objection: Sprints trades a Plane collision for a Jira collision,
and "Sprint" is Jira's and Scrum's most-owned noun. Both facts are true. The
app's own new-cycle placeholder already reads "e.g. Sprint 12," which proves the
word is what people expect.

**I disagree with the conclusion, and here is the argument.**

The review applies one test — "does this word collide with a competitor?" — to
two situations that are not the same problem:

- Colliding with **Plane** is a *fingerprint* problem. The concern is that
  someone opens Waypoint, sees Plane's specific and unusual noun set, and
  concludes it was copied. "Cycle" for a two-week iteration is an odd,
  identifying choice. Five odd choices in a row is evidence.
- Colliding with **Jira/Scrum** is a *familiarity* condition, not a problem.
  "Sprint" is a Scrum term that predates Jira by more than a decade and is used
  by Linear, Shortcut, Azure DevOps, GitHub Projects, Asana and every physical
  standup board on earth. Nobody concludes you copied Jira because you said
  "sprint," for the same reason nobody concludes you copied Jira because you said
  "backlog" — a word this plan also keeps, without objection from the review.

The whole point of choosing the neutral column is to pick words nobody can own.
A word being widely used is the success condition of that strategy, not a
failure of it. **Sprints stays.**

The deeper version of the review's point — that the neutral column makes Waypoint
*less* distinctive and the audit never admitted it — is correct as an
observation and wrong as a criticism. Vocabulary is not where a tracker
differentiates. Nobody chose Linear because of the word "Cycle." Deliberately
spending zero differentiation budget on nouns, so that all of it can go into
behaviour, is the correct allocation. The product strategy document is where
that budget gets spent.

### 2.3 On "Workstreams" — conceding, with a recommendation the founder can decline

The review is right on both counts. In normal PM usage a workstream is a
*program-level lane spanning projects*, and this is an intra-project grouping.
It is also 11 characters in a 244px sidebar.

The founder chose it, and the length problem is mostly solved by the revised IA
(the sub-nav is indented and conditional, so it only appears in projects that
have one). I am recording a recommendation rather than a demand:

> **"Areas"** is five characters, means exactly "a standing part of the product
> that isn't time-boxed," collides with nothing in this category, and does not
> import program-management connotation. If the founder wants a second opinion on
> one word in this table, this is the word.

Note also that the mockup's previous rationale for keeping Workstreams as a
distinct primitive — that a workstream is agent-owned — has been withdrawn.
See product strategy §5. Workstreams now has to justify itself as a plain
grouping primitive, which is a weaker case than it had. Cycles/Modules staying as
two primitives is a founder decision and is respected; this note is so that the
decision is made with the actual reason on the table.

### 2.4 Notes → **Scratchpad**: the collision this plan created, and the fix

The prior work renamed Stickies → **Notes** and Pages → **Docs**. That produced
two note-taking surfaces with synonymous names, one workspace-level and one
project-level, with no rule for which to use. Stickies/Pages was a strange pair,
but the strangeness *told you* which one was ephemeral. This was a regression
introduced by the rename, carried into the mockup, and caught by neither. It is
the sharpest single miss in the prior work and it is fixed here.

**Stickies becomes Scratchpad. Pages stays Docs.**

Why Scratchpad specifically:

1. **It names a place, not a thing type.** The failure mode of Notes/Docs is that
   a user has to choose between two nouns for the same object. Nobody asks
   whether to write "a scratchpad" — you either jot something on the scratchpad
   or you write a doc. The ambiguity disappears at the grammar level.
2. **The word carries the model.** The `Sticky` entity has no project, no
   visibility, no version history, no nesting and a randomly-assigned colour. It
   is author-scoped and disposable. "Scratchpad" is an accurate description of
   that; "Notes" implies something you would come back to.
3. **No collision.** Plane has Stickies. Linear has none. Notion has pages.
   Obsidian and Bear own "notes"; nobody owns "scratchpad" in this category.
4. Ten characters, fits the sidebar.

**And the rule gets written down in the product, not just here.** The Scratchpad
empty state reads:

> Scratchpad is yours and unfiled — quick thoughts that don't belong to a project
> yet. Docs live inside a project and are shared with its members.

A naming collision is only fixed when a user can state the rule. The rule has to
ship in the UI.

Two side effects to fix with it: `Home.tsx`'s "Your stickies" widget, and the
fact that editing a sticky currently deletes and recreates it (there is no update
endpoint), which randomly changes its colour and moves it in the list. That is a
defect, tracked in the product strategy's honesty pass, not here.

### 2.5 On the two "obfuscation" recommendations — struck

The senior review flagged two items in the prior audit as bad instincts:
Archives → Archive because it "breaks the string match" (§4 #19) and reordering
project settings to "perturb the S6 sequence" (§4 #34 / Appendix A).

**The review is right and both rationales are struck.** Deliberately perturbing a
sequence in order to defeat comparison is the wrong instinct, would not survive
contact with anyone asking why, and reads as consciousness of copying. Change
things because they are better.

Both changes survive on their merits, with the reasons rewritten:

- **Archive (singular)** because the page shows one archive, not several. The
  string match is a coincidence of the fix, not its purpose.
- **Project settings reorder** because Codebase does not belong in settings at
  all — it gates the flagship feature and now lives in the project header — and
  because "Work Structure" is a vague group name that "Ticket setup" describes
  better. If, after those two changes, the remaining order still matches Plane's
  documented order, leave it matching. That is what a settings page looks like.

### 2.6 Analytics stays Analytics — reverting a mockup overreach

The prior audit rated Analytics → Insights as Low severity and said "keep." The
mockup then adopted "Insights" anyway. The review caught the inconsistency and is
right that "Insights" promises interpretation and delivers three counters.
Reverted. The mockup now says Analytics.

### 2.7 Views is filed wrong — it is a structural problem, not a cosmetic one

The prior audit filed Views under "cosmetic, keep, generic" while §6.2 of the
same document established that Views is broken structurally: the workspace-level
`/views` nav item opens a page titled "All work items" that is a flat
unfilterable table and is not a views feature, and it shares a name and a
`Layers` icon with the project-level Views, which *is* one.

Renaming the nav slot to "All tickets" — which the mockup did — names the broken
thing accurately without fixing it, and locks in the flat table. The review is
right about that.

The fix is not a rename and belongs in the product strategy: **a view is a saved
filter, and scope is just part of the filter.** One concept, one component; a
project view is a view whose filter includes that project. The workspace slot
then becomes the unscoped default of that surface, with "Save as view" available
from it, which is the workspace-saved-views feature people actually want at zero
additional concept cost. See product strategy §6.

---

## 3. Structural items that belong to this plan

These are collisions that a rename does not fix but that are still hygiene, not
product. Each is small.

| Item | Change | Cost |
|---|---|---|
| `WorkModule.status` six-value enum matching Plane's documented module lifecycle word for word | Collapse to `planned \| active \| paused \| done \| dropped` | Hours |
| `triage` as a sixth `StateGroup` | Remove. A ticket promoted from a Request lands in `backlog` with a `source` field; "needs triage" becomes a saved view | Half a day; net simplification, removes `STATE_GROUP_ORDER` debris, `StateIcon`'s `Inbox` case, and the orphan `triage: 0` counter in `cycle-utils.ts` |
| `ProjectFeatures` five-key toggle grid | Delete the type and the surfaces | See product strategy §4 |
| `pages/admin/**` — six-route Instance admin | Delete. Six fully-built pages including an SMTP form and OAuth client-secret collection, with no entry point anywhere in the app | Net deletion of ~500 lines; also removes the OpenAI-key page that contradicts the actual Copilot runtime |
| `Network` → `Visibility` in the type, the label and the project-list filter | Rename | Hours |

The Instance admin deletion deserves a note: it is simultaneously the clearest
structural evidence of provenance in the codebase (a self-hosted-web-app control
panel carried into a single-user desktop app, with a Workspaces page whose own
copy reads "This instance hosts a single workspace") **and** a live security
smell (`admin/Auth.tsx` collects an OAuth client secret and discards it on save;
`admin/Email.tsx` collects an SMTP password into local state). Deleting it is
the highest value-per-line change in this document.

---

## 4. Execution

One branch. Roughly this order, because each step de-risks the next.

1. **Answer §0.** Before writing any code. If the answer is not clean, stop.
2. **Copy purge** (§1) — all three locations plus the empty-state sweep. Merge
   this on its own; it should not wait behind anything.
3. **Delete `pages/admin/**`** (§3). Pure deletion, no dependencies.
4. **The rename batch** (§2) as one commit-set: types → routes → components →
   backend schema + migration → MCP tools + `copilotRunner.ts` system prompt →
   README. Shipping this partially is worse than not shipping it, because a
   hybrid vocabulary costs you the readability *and* leaves the fingerprint.
5. **`WorkModule.status` and the `triage` state group** (§3). Same branch, own
   commits.

No webhook back-compatibility window. There are no external consumers. Decide
that explicitly here rather than by omission: **the webhook event names break,
and that is fine today and will not be fine in three months.**

**Total: a weekend, plus the hour in §0.**

---

## 5. What this plan does *not* do

It does not make anyone want to use Waypoint. Every change above is subtraction —
removing resemblance, removing dead surfaces, removing copied sentences. The
product is not more compelling at the end of this weekend than it was at the
start; it is just no longer wearing someone else's clothes.

The prior audit's central confusion was treating that subtraction as
differentiation. Renaming Cycles to Sprints moves Waypoint *toward* the
industry-generic centre. It is the right move and it is not a product strategy.

The product strategy is the other document.
