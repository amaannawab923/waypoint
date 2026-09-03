# Waypoint differentiation audit — UX, terminology, and IA vs. Plane

Status: research and proposal. No application code changed by this document.

Scope: `waypoint-frontend/src/renderer/**` (read in full), plus
`waypoint-backend/src/{db/schema,routes,services,mcp}` and
`docs/design/copilot-*.md` for the model and product-identity read. Plane's
current product was researched against plane.so, docs.plane.so, and
github.com/makeplane/plane in September 2026.

**Confidence tags.** Everything in §2 (Waypoint's current state) was read
directly out of this repo and is cited by file and line. Claims about *Plane*
carry one of:

- **[verified]** — fetched from docs.plane.so, plane.so/pricing, or the
  makeplane/plane repo during this audit. Source listed in Appendix C.
- **[verified-in-repo]** — the artifact is in Waypoint's own source, so the
  finding holds regardless of what Plane does today.
- **[unverified]** — I could not confirm it from a public page. Treat as a lead,
  not a finding.

---

## 1. Executive summary

### 1.1 Headline

The similarity to Plane is real and pervasive. It is also more specific than
"looks like Plane" — the research turned up a sharper characterisation:

> **Waypoint is a faithful clone of a particular *vintage* of Plane: roughly
> Plane's 2024-era free tier. It reproduces that version's vocabulary, sidebar,
> settings IA, and data model closely — and contains none of the concepts Plane
> has since built (Initiatives, Teamspaces, Releases, Milestones, Wiki,
> Customers, Dashboards, Work Item Types, Time Tracking, Templates).**

That framing matters for three reasons. It makes the provenance harder to deny
(you don't independently arrive at a competitor's *older* feature set). It means
the collision is bounded and enumerable rather than open-ended. And it means
Plane has already vacated some of the ground — differentiating is less about
running away from Plane than about not standing where Plane used to stand.

Three findings, in descending urgency:

**Finding 1 — There is verbatim-or-near-verbatim copied UI prose in the product.
This is the only finding with real legal exposure and should be fixed this week
regardless of every other decision here.**

`pages/project-settings/Automations.tsx:123`:

> "Waypoint will auto archive work items that have been completed or canceled."

That is a product-name substitution away from Plane's own automation copy. The
same pattern runs through all five feature descriptions in
`pages/project-settings/Features.tsx:14-36` — "Timebox work per project and
adjust the time period as needed", "Organize work into sub-projects with
dedicated leads and assignees", "Let non-members share bugs, feedback, and
suggestions; without disrupting your workflow". Copied *structure* is a
defensible design-convergence argument. Copied *prose* is not. Rewriting costs an
afternoon. See §7 Phase 0.

**Finding 2 — Roughly 55 user-facing concepts collide; ~38 are pure naming, ~17
are structural.** The structural set is where Waypoint inherited Plane's product
*architecture* rather than its vocabulary: the `Project.features` toggle grid,
the Cycles-vs-Modules double grouping, Intake's status machine, the estimate
system, and an entire cloned "Instance admin" surface that is product-nonsensical
in a single-user desktop app. Renaming those leaves Plane's model under new
labels.

**Finding 3 — Waypoint already has a genuine, defensible identity in this
codebase, and the IA actively hides it.** The differentiator is not "project
management". It is: *a native desktop tracker where the AI teammate can read the
actual repository the ticket is about, running on the user's own local Claude
subscription, where every write it performs is an explicit, reviewable proposal,
and where agents are first-class assignees alongside humans.* Today that reaches
the user through a feature flag, a sparkle icon, an Agents page three levels deep
in workspace settings, and a repo-linking screen buried in project settings —
while prime sidebar real estate goes to Stickies (which is itself a Plane
feature name).

### 1.2 Risk assessment

| Dimension | Level | Why |
|---|---|---|
| Copied UI prose | **High** | Concrete, provable, cheap to fix. Fix now. |
| Terminology collision | **High** | Confirmed verbatim on Cycles, Modules, Intake, Pages, Views, Work Items, Stickies, Drafts, Your Work, Inbox. The *set* is an unmistakable fingerprint (§3.2). |
| Structural / model collision | **Medium-high** | Project-settings section order is an exact match (§3.3 S6). State groups match exactly (§3.3 S3). Offset by genuine divergences (§3.5). |
| Visual identity | **Low** | Waypoint is already visually distinct. One shared dependency (Lucide) is not a finding — see §8. |
| Product differentiation | **High, as opportunity** | The Copilot/agent story is novel and buried. |

### 1.3 Headline recommendation

1. **Purge the copied strings.** Days, not weeks. Unconditional.
2. **Ship one rename batch** covering all ~38 cosmetic collisions at once, plus
   a migration for the `Project.features` JSON keys. Bundled, because a partial
   rename leaves the fingerprint intact *and* creates a hybrid vocabulary (§3.2).
3. **Re-architect the IA around the agent story rather than around Plane's
   feature grid.** Promote Copilot, Agents, and Codebase-linking into primary
   navigation; delete Instance admin; collapse Cycles+Modules. This is what makes
   Waypoint not-a-reskin in substance rather than in labels.

**Do not redesign the visual language.** See §8.

---

## 2. Full current-state inventory

Line references are to `waypoint-frontend/src/renderer/` unless prefixed.

### 2.1 Routes and top-level pages (`router.tsx`)

| Path | Component | Heading actually rendered |
|---|---|---|
| `/login` · `/signup` | `pages/auth/*` | "Waypoint" |
| `/onboarding/workspace` | `auth/CreateWorkspace` | "Name your workspace" |
| `/` | `pages/Home` | "Good morning/afternoon/evening, {displayName}" |
| `/your-work` | `pages/YourWork` | "Your work" |
| `/drafts` | `pages/Drafts` | "Drafts" |
| `/stickies` | `pages/Stickies` | "Stickies" |
| `/notifications` | `pages/Notifications` | **"Inbox"** (nav label: "Notifications") |
| `/projects` | `pages/ProjectsList` | "Projects" |
| `/projects/archived` | `pages/ArchivedProjects` | "Archived projects" |
| `/analytics` | `pages/AnalyticsPage` | "Analytics" |
| `/views` | `pages/WorkspaceViewsPage` | **"All work items"** (nav label: "Views") |
| `/sessions` | `sessions/SessionsScreen` | flag-gated; full-viewport, no shell |
| `/projects/:id/work-items` | `work-items/WorkItemsLayout` | "{project} / Work Items" |
| `/projects/:id/work-items/:identifier` | `WorkItemDetailPage` | item title |
| `/projects/:id/cycles[/:cycleId]` | `CyclesPage` · `CycleDetailPage` | "Cycles" |
| `/projects/:id/modules[/:moduleId]` | `ModulesPage` · `ModuleDetailPage` | "Modules" |
| `/projects/:id/views` | `ProjectViewsPage` | "Views" |
| `/projects/:id/pages[/:pageId]` | `PagesPage` · `PageDetailPage` | "Pages" |
| `/projects/:id/intake` | `IntakePage` | "Intake" |
| `/projects/:id/settings/*` | `ProjectSettingsLayout` | §2.5 |
| `/settings/*` | `WorkspaceSettingsLayout` | §2.6 |
| `/profile/*` | `ProfileSettingsLayout` | §2.7 |
| `/admin/*` | `AdminLayout` | "Instance admin" — §2.8 |

### 2.2 Sidebar IA (`layouts/Sidebar.tsx`)

Header: a `Compass` glyph in a gradient square + workspace name. (The compass is
the only navigation-metaphor asset in the product — relevant to §4.)

**Top group** (92–115): Home (`Home`) · Your work (`UserRound`) · Drafts
(`FileEdit`) · Stickies (`StickyNote`) · Sessions (`Bot`, flag-gated).

**Projects group** (117–134): "PROJECTS" header + `Plus`; "All projects"
(`FolderKanban`); one expandable row per project.

**Per-project sub-nav** (39–46), each gated on a `project.features` flag:

| Label | Icon | Gate |
|---|---|---|
| Work items | `LayoutList` | always |
| Cycles | `RefreshCw` | `features.cycles` |
| Modules | `Boxes` | `features.modules` |
| Views | `Layers` | `features.views` |
| Pages | `FileText` | `features.pages` |
| Intake | `Inbox` | `features.intake` |

**Bottom group** (136–153): Views (`Layers`) · Archives (`Archive`) · Analytics
(`BarChart2`) · Workspace settings (`Settings`).

### 2.3 Topbar (`layouts/Topbar.tsx`)

Search ("Search…", `⌘K`) opening a palette whose placeholder is "Search work
items, pages, projects, cycles, modules…" and whose result groups are **Work
items · Pages · Projects · Cycles · Modules** (209–215). Primary button **"New
work item"**. Theme toggle. Notifications bell. Copilot toggle (`Sparkles`,
gated). Account menu: "Profile settings" / "Sign out".

### 2.4 Entity model (`types/entities.ts`)

```
StateGroup   = backlog | unstarted | started | completed | cancelled | triage
Priority     = urgent | high | medium | low | none
Network      = public | private
MemberRole   = admin | member | guest
PlanTier     = community | pro | business | enterprise
EstimateType = points | categories
IntakeStatus = pending | accepted | declined | duplicate
WorkModule.status = backlog | planned | in-progress | paused | completed | cancelled
Page.visibility   = public | private | archived
ExportStatus      = completed | processing | failed
WebhookEventType  = work_item.{created,updated,deleted} | project.created
                  | cycle.created | module.created
ActivityVerb = created | state_changed | priority_changed | assignee_added
             | assignee_removed | label_added | label_removed | commented
             | start_date_set | due_date_set | module_added | cycle_added
             | sub_item_added | link_added | agent_assigned | agent_status_changed
NotificationItem.kind = mention | assigned | comment | state_change
                      | agent_needs_review | agent_blocked
```

Waypoint-original enums (no Plane analogue):

```
AgentAutonomy   = plan-only | ask-before-write | ask-before-pr | full-auto
AgentTrigger    = manual | on-assign | on-comment-mention | on-label
ExecutionMethod = local-claude-subscription | local-codex-subscription
                | local-gemini-subscription | hosted-api-key
AgentRunStatus  = queued | running | needs-review | blocked | done | failed
CopilotProposalKind   = comment | state_change | assignee_change
                      | priority_change | create_work_item
CopilotProposalStatus = proposed | executing | executed | rejected
                      | stale | expired | superseded
SessionIntent   = rca | comment | follow-up | full-coding | custom
```

**The single most damning artifact** (`entities.ts:37-43`):

```ts
export interface ProjectFeatures {
  cycles: boolean;
  modules: boolean;
  views: boolean;
  pages: boolean;
  intake: boolean;
}
```

Five Plane primitive names, verbatim, in one type, arranged as a feature-toggle
grid — which is itself Plane's architecture decision, not just its vocabulary.

**Entity fields:**

- `Workspace` — id, name, slug, companySize, timezone, plan, createdAt,
  restrictWorkspaceCreation
- `Member` — id, workspaceId, fullName, displayName, email, avatarColor, role,
  authMethod (email|google|github|gitlab|gitea), joinedAt
- `Project` — id, workspaceId, name, identifier, description, icon (emoji),
  coverGradient, network, leadId, defaultAssigneeId, timezone, features,
  estimate, automations, createdAt, archivedAt, memberIds, guestAccessEnabled,
  **repoPath** *(Waypoint-original)*
- `ProjectAutomations` — autoArchiveEnabled, autoArchiveAfterDays,
  autoCloseEnabled, autoCloseAfterDays
- `WorkItemState` — id, projectId, name, group, color, isDefault, sortOrder
- `WorkItem` — id, projectId, identifier (`WAY-12`), sequenceId, title,
  description, stateId, priority, assigneeIds, labelIds, moduleId, cycleId,
  parentId, estimatePoints, estimateValue, startDate, dueDate, createdById,
  createdAt, updatedAt, attachmentCount, linkCount, links, isDraft
- `Cycle` — id, projectId, name, description, startDate, endDate, leadId, memberIds
- `WorkModule` — id, projectId, name, description, leadId, status, startDate,
  targetDate, memberIds
- `Page` — id, projectId, title, icon, contentHtml, visibility, ownerId,
  isFavorite, isLocked, parentPageId, createdAt, updatedAt
- `SavedView` — id, projectId, name, ownerId, filters, visibility, isFavorite, updatedAt
- `IntakeRequest` — id, projectId, title, description, status, priority,
  sourceName, sourceEmail, createdAt, linkedWorkItemId
- `Sticky` — id, authorId, title, body, color, updatedAt
- `Agent` — id, workspaceId, name, avatarColor, instructionsFile
  (`{filename, contentMarkdown}`), scopeAllProjects, scopeProjectIds,
  executionMethod, model, autonomy, triggers, templateId, isActive, createdById
- `AgentAssignment` — id, workItemId, agentId, status, summary, startedAt

**Notably absent:** any relations model. `parentId` + sub-work-items and nothing
else. See §6.10.

### 2.5 Project settings IA (`project-settings/ProjectSettingsLayout.tsx`)

| Group | Items |
|---|---|
| *(ungrouped)* | General · Members · Features · **Codebase** |
| "Work Structure" | States · Labels · Estimates |
| "Execution" | Automations |

- **General** — Project name, Project ID ("The project identifier cannot be
  changed after creation."), Description, **Network**, Project Timezone, Created
  on, Archive project, Delete project.
- **Members** — Project Lead, Default Assignee, member table.
- **Features** — five toggles; copy quoted in §1.1.
- **Codebase** — *Waypoint-original.* Native folder picker linking the project to
  a local git checkout (`repoPath`); backend validates it is a real repo.
- **States** — "Manage the workflow states work items move through." Grouped by
  state group; per-state name/colour/default; two-click delete confirm.
- **Labels** — name + colour.
- **Estimates** — "Define how your team measures effort and track it consistently
  across all work items." Two presets:
  - **Points** — "Fibonacci-style points to estimate relative effort." `0,1,2,3,5,8,13,21`
  - **Categories** — "T-shirt sizes for a lightweight, relative estimate." `XS,S,M,L,XL,XXL`
- **Automations** — "Auto-archive closed work items" and "Auto-close work items",
  each with an "After {n} {unit}" control. Copy quoted in §1.1.

### 2.6 Workspace settings IA (`WorkspaceSettingsLayout.tsx`)

| Group | Items |
|---|---|
| "Administration" | General · Members · **Agents** · Billing and plans · Exports |
| "Developer" | Webhooks |

- **General** — workspace name, company-size select, timezone, Delete workspace.
- **Members** — Name · Display name · Email · Role · Auth · Joined; invite by email.
- **Agents** — *Waypoint-original.* Detail page: name, avatar colour,
  **instructions file** (`agent.md`, raw markdown), scope (All current projects /
  Specific projects), execution method, model, **autonomy** (Plan only / Ask
  before write / Ask before PR / Full auto), **triggers** (When assigned to a
  ticket / When @mentioned in a comment / When a specific label is added), active
  toggle. Starter templates: Code Reviewer · Release Notes Writer · Bug Triage.
- **Billing and plans** — Pro / Business / Enterprise cards.
- **Exports** — format picker + history.
- **Webhooks** — URL + the six event types in §2.4.

### 2.7 Profile settings IA

| Group | Items |
|---|---|
| "Your profile" | Profile · Preferences · Notifications · Security · **Copilot** |
| "Developer" | Personal access tokens |

Preferences: Timezone, Language, First day of week. Notifications: Email, Push,
Notify on mentions, Notify on comments. Copilot: *Waypoint-original* Claude
connection state.

### 2.8 Instance admin IA (`pages/admin/AdminLayout.tsx`)

Header "Instance admin"; "← Back to Waypoint".

| Item | Contents |
|---|---|
| General | Instance name, Instance ID, Admin email, "Share anonymous usage data" (Telemetry) |
| Email | SMTP config |
| Authentication | auth-provider config |
| Workspaces | *"This instance hosts a single workspace."* |
| **AI** | **OpenAI** API key + model picker (GPT-4o, GPT-4o mini) |
| Images | image-provider key |

### 2.9 Work-items surface

**Layout tabs** (`WorkItemsLayout.tsx:34-40`): **List** · **Board** ·
**Calendar** · **Spreadsheet** · **Gantt**.

**Group by**: State · Priority · Module · Cycle · Assignee · None.
**Filters**: Priority · State · "Clear filters". **Primary**: "Add work item".
**Peek**: `?peek=IDENT` opens `WorkItemDrawer`.

**Detail property rail**, in order: Assignees (the picker carries an **"Agents"**
sub-header — humans and agents share the assignee id space), Priority, Estimate,
Created by, Start date, Due date, Modules, Cycle, Parent, Labels. Below:
**Sub-work items ({n})** with progress bar and "{x} of {y} done", Links,
**Activity**, **Comments**.

**State icons** (`StateIcon.tsx`) — triage `Inbox` · backlog `CircleDashed` ·
unstarted `Circle` · started `CircleDot` · completed `CircleCheck` (filled) ·
cancelled `CircleX`. Column order: `triage, backlog, unstarted, started,
completed, cancelled`.

**Priority icons** — Urgent `AlertTriangle` · High `SignalHigh` · Medium
`SignalMedium` · Low `SignalLow` · None `Minus`.

**Seeded states** (`waypoint-backend/src/services/projects.service.ts:63-68`):
Triage, Backlog, Todo, In Progress, Done, Cancelled. The dev seed adds "In
Review".

### 2.10 Home (`pages/Home.tsx`)

Greeting + date → **Quickstart guide** (dismissible; Create a project / Invite
your team / Set up your workspace / Make Waypoint yours) → **Quicklinks**
(permanent empty state, §6.5) → **Your stickies** → **Recents** (filter: All /
Work items / Pages / Cycles / Modules).

### 2.11 Copilot & agents (the differentiator)

- `CopilotPanel` — 400px right slide-over mounted globally in `AppShell` as a
  sibling of the router `<Outlet/>`, persisting across navigation. Placeholder
  "Ask Copilot…"; empty state "Ask Copilot anything — it can help with your
  **tickets**." Session list with rename/pin; "New session"; "Reject all pending".
- `CopilotProposalCard` — approval cards: Applying… / Applied ✓ / Stale /
  Expired / Dismissed. Each proposal carries a `snapshot` of names and colours
  captured at propose time, plus a server-computed `disclosureText` prefix that
  an approved comment must carry.
- **Grounding** (`lib/useCurrentRouteProject.ts`,
  `docs/design/copilot-v3-codebase-grounding.md`) — conversations are *not*
  project-scoped; the repo grounding the next message is whichever
  `/projects/:projectId/...` route is currently open.
- **Tool grants** (`src/main/copilot/copilotRunner.ts`) — exactly
  `['Read', 'Glob', 'Grep']`, never Bash/Edit/Write, with a denylist covering
  `.env*`, `.git/**`, `.ssh/**`, `*.pem`, `id_rsa*`, `*credentials*`.
- **MCP tools** (`waypoint-backend/src/mcp/`, server name `waypoint`):
  `list_work_items`, `get_work_item`, `get_work_item_by_identifier`,
  `search_work_items`, `list_comments`, `list_activity`, `list_states`,
  `list_members`, plus propose-* write tools.
- **Sessions** (flag-gated) — intents: "Research & give RCA" · "Comment on the
  ticket" · "Follow up on the ticket" · "Start working on this bug" · "Custom
  instruction".

### 2.12 Visual language (`index.css`)

- **Type** — Space Grotesk (display), Public Sans (body, 14px/1.5), JetBrains
  Mono. Google Fonts via `index.ejs`.
- **Accent** — deliberately **monochrome**: `#18181b` on light, inverting to
  `#f2f2f4` on dark, plus a subtle `--accent-gradient`. Colour is reserved for
  success/warning/danger/info.
- **Radii** — `--radius-sm: 6px` · `--radius: 10px` · `--radius-lg: 16px`.
- **Theming** — Tailwind v4 `@theme inline` over CSS custom properties;
  `:root[data-theme='dark']`; pre-paint inline script prevents theme flash.
- **Icons** — `lucide-react` (58 files); 13–16px; `strokeWidth: 2.2` on
  state/priority glyphs.
- **Density** — 8px grid; 32px nav rows; 48px topbar; 256px sidebar; thin
  scrollbars.
- **Boot splash** — animated mark-draw + wordmark + tagline; the one surface that
  inverts the palette.

---

## 3. Collision map vs. Plane

### 3.1 Cosmetic collisions — a different word fully fixes it

| Waypoint | Where | Plane today | Confidence | Severity |
|---|---|---|---|---|
| **Cycles** | sidebar, flag, page, search group, webhook, Recents | Cycles | **[verified]** | **High** — signature term |
| **Modules** | sidebar, flag, page, group-by, webhook | Modules | **[verified]** | **High** — "Module" for a feature-grouping is a distinctly odd word to land on twice |
| **Intake** | sidebar, flag, page, "Public intake form" | Intake (Business+) | **[verified]** | **High** — Plane renamed Inbox→Intake; Waypoint inherited the *result* of that rename |
| **Pages** | sidebar, flag, page | Pages | **[verified]** | Medium |
| **Views** | project + workspace nav, flag | Views | **[verified]** | Low-medium — generic across the category |
| **Work items** | everywhere | Work Items (renamed from Issues) | **[verified]** | Medium-high — also Azure DevOps' term, but Plane's rename is recent and Waypoint matches the post-rename state |
| **Stickies** | sidebar, `/stickies`, "Your stickies" | Stickies | **[verified]** | **High** — an unusual feature to share by name |
| **Drafts** | sidebar, `/drafts` | Drafts | **[verified]** | Medium — generic word, but same feature, same slot |
| **Your work** | sidebar | Your Work | **[verified]** | Medium |
| **"Inbox"** (Notifications heading) | `Notifications.tsx:79` | Inbox = Plane's notification hub | **[verified]** | Medium — see §6.3; this is *both* an internal inconsistency and a Plane match |
| **Network** (project visibility) | field, settings label, list filter | Plane's docs say **"visibility"**; `network` is Plane's older data-model name | **[verified]** / **[unverified]** for the API history | **High as evidence** — an internal field name surfacing as a UI label is strong provenance signal (§3.4) |
| **Triage** | state group label + `Inbox` icon | Triage (system-managed state) | **[verified]** | Medium — see S3 |
| Priority `urgent/high/medium/low/none` | `PriorityIcon.tsx` | identical five | **[verified]** | Low — industry-standard |
| Estimates **Points** / **Categories** | project settings | Points / Categories / Time | **[verified]** | **Medium-high** — the exact pair of type names, and Waypoint's Categories are T-shirt sizes exactly as Plane's are |
| Plan tiers `pro/business/enterprise` | `PlanTier` | Pro / Business / Enterprise Grid | **[verified]** | Medium — Waypoint's `community` differs from Plane's `Free` |
| **Archives** | sidebar | Archives | **[unverified]** | Low |
| **Analytics** | sidebar | Analytics (Business+) | **[verified]** | Low — generic |
| Home widgets **Quicklinks / Stickies / Recents** | Home | Plane home widgets | **[unverified]** in detail; Stickies **[verified]** | **High as a set** — §3.2 |
| Member roles `admin/member/guest` | `MemberRole` | Owner/Admin/Member/Guest (workspace) | **[verified]** | Low — Waypoint lacks Owner; generic trio |

### 3.2 The set is worse than the parts

Each row above is individually defensible. The *combination* is not. A Plane user
opening Waypoint sees, with no ambiguity:

- a sidebar reading **Home / Your work / Drafts / Stickies** — Plane's is
  **Home / Your Work / Inbox / Drafts / Stickies** **[verified]**. Four of five
  in order, with Waypoint's only omission being the item it *does* have under a
  different label;
- expanding a project to reveal **Work items / Cycles / Modules / Views / Pages /
  Intake**, each behind a per-project toggle;
- a home screen of greeting → quickstart → quicklinks → stickies → recents;
- project settings reading **General / Members / Features / States / Labels /
  Estimates / Automations** — which is Plane's documented section list **in
  exactly that order** **[verified]**, with Waypoint's single original item
  (Codebase) inserted at position 4;
- a `ProjectFeatures` type naming five Plane primitives verbatim.

Five independent axes aligning is a fingerprint, not convergence. **This is the
argument for shipping the rename as one batch** (§7 Phase 1): changing three of
five leaves the fingerprint while costing you a hybrid vocabulary.

### 3.3 Structural collisions — renaming alone does not fix these

**S1 — `ProjectFeatures` as a toggle grid.** [verified-in-repo; Plane's Features
page **[verified]** toggles Cycles, Modules, Pages, Time Tracking et al.] The
collision is not the five words; it is the architecture decision that a project
is a container you switch sub-products on and off inside. Renaming the keys
leaves Plane's model wearing a hat.

**S2 — Cycles vs. Modules as two parallel groupings.** [verified-in-repo +
**[verified]** on Plane's side] Both project-scoped; both carry `name`,
`description`, `leadId`, `memberIds`; Cycles have `startDate`/`endDate`, Modules
have `startDate`/`targetDate` plus a six-value `status`. **Waypoint's
`WorkModule.status` is `backlog | planned | in-progress | paused | completed |
cancelled` — Plane's documented module lifecycle is Backlog, Planned, In
Progress, Paused, Completed, Cancelled [verified]. Six values, same six words,
same order.** That is the tightest single match in this audit and it is in the
data model, not the copy. The research also confirms Plane treats this pairing as
one of its own distinctive choices.

**S3 — State groups.** [verified-in-repo + **[verified]** on Plane]
Plane's five state groups are **Backlog, Unstarted, Started, Completed,
Cancelled**, with default state names Backlog / Todo / In Progress / Done /
Cancelled. Waypoint's `StateGroup` carries those five identically, and its
seeded state names are Backlog / Todo / In Progress / Done / Cancelled —
**an exact match on both the groups and their default names.**

Two nuances that cut in opposite directions:

- *Mitigating:* this five-type taxonomy is widely believed to originate with
  Linear rather than Plane, which would make it an industry pattern rather than
  Plane's property. **[unverified — my research did not confirm this, and it
  should be checked before anyone leans on it defensively.]**
- *Aggravating:* Plane treats **Triage as a system-managed state that sits
  outside project states** [verified]. Waypoint promoted it to a sixth
  **`StateGroup`** — a divergence, but one that only makes sense if you started
  from Plane's model and then flattened it. It also creates real internal
  debris: `cycle-utils.ts` carries a `triage: 0` counter that `BREAKDOWN_ORDER`
  then excludes.

**S4 — Intake as a separate queue with its own status machine.**
[verified-in-repo] `IntakeStatus = pending | accepted | declined | duplicate`, a
public submission form, a "Review before accepting" modal, `linkedWorkItemId` on
acceptance. Plane gates Intake behind Business+ [verified]; Waypoint ships it in
the base product.

**S5 — Estimates as one project-level system with two preset types.**
[verified-in-repo] Plane offers **Points, Categories, and Time**, with Points
sub-types Linear/Fibonacci/Squares/Custom and Categories sub-types T-shirt
sizes/Easy-to-Hard/Custom [verified]. Waypoint implements exactly the first two
type names, with Points = Fibonacci and Categories = T-shirt sizes — i.e. Plane's
two default choices, with the names of the *categories* kept and the names of the
*sub-types* dropped.

**S6 — Project settings section order.** **[verified]** Plane's documented order
is General → Members → Features → States → Labels → Estimates → Automations.
Waypoint's is General → Members → Features → **Codebase** → States → Labels →
Estimates → Automations. A seven-item exact sequence with one insertion. This is
the strongest structural evidence in the audit after S2.

**S7 — The Instance admin surface.** [verified-in-repo] Six routes; an OpenAI key
form that contradicts the actual Copilot runtime; SMTP config with nothing to
send; an image-provider key; and a Workspaces page whose own copy reads *"This
instance hosts a single workspace."* This is a self-hosted-web-app control panel
carried into a single-user desktop app. Simultaneously the clearest structural
evidence of provenance and pure dead weight.

**S8 — Two automations, exactly auto-archive and auto-close, with copied
descriptions.** [verified-in-repo] §1.1.

### 3.4 The `Network` field is the sharpest single piece of evidence

Plane's current documentation describes the project setting as **visibility
(Public/Private)** [verified]. Waypoint's UI label is **"Network"**
(`project-settings/General.tsx`), and its type is `Network = 'public' |
'private'` (`entities.ts:8`).

"Network" is not a natural English label for project visibility. It is, to the
best of my knowledge, the name of the field in Plane's *data model* rather than
its UI **[unverified — worth confirming against the makeplane/plane schema]**. A
backend field name surfacing as a user-facing label in a different product is
harder to explain as convergence than any amount of shared vocabulary. Renaming
it is trivial (§4 #10) and should not wait.

### 3.5 Where Waypoint genuinely diverges from Plane

For balance and for the defence file — Plane has these and Waypoint does not
[all **[verified]**]: Initiatives, Teamspaces, Releases, Milestones, Wiki,
Customers, Dashboards, Work Item Types (custom types + Epics-as-a-type), Time
Tracking / worklogs, Templates, Work Item Updates (On Track / At Risk / Off
Track), the six relation types, Owner as a workspace role, Estimates→Time,
and Plane's v1.2.0 top-nav redesign (Waypoint still mirrors Plane's *older*
expandable-sidebar model).

And Waypoint has these, which Plane does not: `repoPath` + the Codebase settings
page; the entire Copilot runtime (local Claude subscription execution,
`Read`/`Glob`/`Grep`-only grants, secrets denylist, grounding-follows-the-open-
page); the propose→approve model with its seven-state status machine, snapshots,
and mandatory self-disclosure; `Agent` as a sibling of `Member` in the assignee
id space, with an autonomy ladder, triggers, and a markdown instructions file;
`AgentAssignment` / `AgentRunStatus`; agent activity verbs and
`agent_needs_review` / `agent_blocked` notifications; Sessions and dispatch
intents; and a monochrome visual identity.

**This is the shape of the problem in one paragraph: Waypoint's *tracker* is
Plane's 2024 tracker, and Waypoint's *agent layer* is entirely its own.** The
remedy is to make the second thing the product and the first thing the substrate.

### 3.6 One correction the research forced

I had initially recommended renaming the **Spreadsheet** and **Gantt** layout
tabs to **Table** and **Timeline** on the assumption those were the neutral
industry terms. The research shows Plane's five layouts are today **List, Board,
Calendar, Table, Timeline** [verified] — so that rename would have moved Waypoint
*from* two non-matching names *to* two exact matches, increasing the collision.

Corrected recommendation in §4 #11–12: **keep Spreadsheet and Gantt**, or move
further away (Grid / Schedule). This is a good illustration of why the remaining
**[unverified]** rows in §3.1 should be checked before anyone acts on them.

---

## 4. Proposed rename table

Two options per row; **bold** is my recommendation.

The **Navigational** column commits to Waypoint's own name — a waypoint is a
fixed point on a route, and the product already ships a `Compass` mark and a
mark-draw boot animation. It yields a coherent, ownable vocabulary. The
**Neutral** column is the low-risk industry-generic fallback.

Pick one column per *cluster*, not per row — "Legs" mixed with "Workstreams" is
incoherence.

| # | Current | Navigational (recommended) | Neutral (safe) | Rationale |
|---|---|---|---|---|
| 1 | Work item | **Ticket** | Task | Already the word Waypoint's *own* agent surfaces use — `SESSION_INTENT_LABEL` says "Comment on the ticket", `AgentDetailPage` says "When assigned to a ticket", `CopilotPanel` says "help with your tickets". Adopting it fixes a live internal inconsistency (§6.7) *and* drops Plane's post-rename headline noun. |
| 2 | Cycles | **Legs** | Sprints | A leg is a bounded stretch of a journey between two waypoints — literally a timeboxed iteration. Ownable, on-brand. `Sprints` is the zero-learning-curve fallback nobody can own. |
| 3 | Modules | **Tracks** | Workstreams | A track is a continuing line of travel that is *not* time-bounded — precisely the cycle/module distinction, in one word instead of a docs page. Also kills the "module = code module" ambiguity in a product that literally reads your code. |
| 4 | Intake | **Requests** | Requests | Names the artifact, not the process. Also disambiguates from the Notifications-page-titled-Inbox (§6.3). Same answer in both columns. |
| 5 | Pages | **Docs** | Docs | Cheap, clearer, removes a member of the five-flag set. |
| 6 | Views | **Views** (keep) | Views (keep) | Genuinely generic — Linear, Jira, Notion, Height all ship "views". Fix the *IA* problem instead (§6.2). |
| 7 | Stickies | **Notes** | Notes | Unusual name, buys nothing, confirmed Plane feature. |
| 8 | Your work | **My work** | My work | Generic, and first-person reads better. |
| 9 | Drafts | **Drafts** (keep) | Drafts (keep) | Fully generic; the collision is the sidebar *slot*, fixed by §5.5. |
| 10 | Network *(field + label + filter)* | **Visibility** | Visibility | §3.4. Highest evidence-value-per-hour rename in the table. Values stay `public`/`private`. |
| 11 | Spreadsheet *(layout)* | **keep** (or Grid) | keep | **Corrected — see §3.6.** Plane now uses "Table"; renaming to Table would *increase* collision. |
| 12 | Gantt *(layout)* | **keep** (or Schedule) | keep | **Corrected — see §3.6.** Plane now uses "Timeline". |
| 13 | Sub-work items | **Subtasks** | Subtasks | Drops the unusual compound; follows #1. |
| 14 | Triage *(state group)* | **remove** — §5.3 | Remove | Should not be a state group. |
| 15 | Estimates → Points | **Points** (keep) | Points (keep) | Generic once #16 lands. |
| 16 | Estimates → Categories | **Sizes** | T-shirt sizes | "Categories" for t-shirt sizes is needlessly abstract, and it is Plane's exact type name (§3.3 S5). The UI already renders `XS…XXL`. |
| 17 | Billing and plans | **Plan** | Billing | Drops an exact-phrase match; a desktop app on a local subscription barely needs the page. |
| 18 | Instance admin *(whole surface)* | **delete** — §5.7 | Delete | |
| 19 | Archives | **Archive** (singular) | Archive | Trivial; breaks the string match. |
| 20 | Analytics | **Analytics** (keep) | Insights | Generic. |
| 21 | `ProjectFeatures` keys | `{legs, tracks, views, docs, requests}` — **and see §5.1** | `{sprints, workstreams, views, docs, requests}` | Needs a migration; the shape should change too. |
| 22 | Webhooks `cycle.created` / `module.created` | `leg.created` / `track.created` | `sprint.created` / `workstream.created` | External contract — see Phase 1 note. |
| 23 | Webhooks `work_item.*` | `ticket.*` | `task.*` | Same. |
| 24 | Search palette group labels | follow 1–5 | follow | `Topbar.tsx:209-215` |
| 25 | Recents filter labels | follow 1–5 | follow | `Home.tsx:30-36` |
| 26 | Group-by "Module" / "Cycle" | follow 2–3 | follow | `WorkItemsLayout.tsx:42-49` |
| 27 | Activity verbs `module_added` / `cycle_added` / `sub_item_added` | follow 2, 3, 13 | follow | `entities.ts:170-186` |
| 28 | "Add work item" / "New work item" | "New ticket" | "New task" | follow #1 |
| 29 | Analytics stat tiles | follow 1–5 | follow | `AnalyticsPage.tsx:83-88` |
| 30 | Quickstart copy "…work items, cycles, and modules" | follow 1–3 | follow | `Home.tsx:133` |
| 31 | Empty-state copy across ~20 files | rewrite in Waypoint's voice | rewrite | Phase 0 |
| 32 | Feature descriptions ×5 | **rewrite from scratch** | rewrite | Phase 0 — copied prose |
| 33 | Automation descriptions ×2 | **rewrite from scratch** | rewrite | Phase 0 — copied prose |
| 34 | Settings group "Work Structure" | "Ticket setup" | "Ticket setup" | follow #1; also perturbs the §3.3 S6 sequence |
| 35 | Cycle status Active/Upcoming/Completed | keep | keep | Generic — though note Plane uses the same three [verified]; low severity |
| 36 | `WorkModule.status` six values | **change** — §5.2 / §5.9 | change | Exact six-value match (§3.3 S2). Even if S2 is deferred, this enum should change. |
| 37 | Search placeholder | follow 1–5 | follow | `Topbar.tsx:249` |
| 38 | Notifications heading "Inbox" | "Notifications" | "Notifications" | Fixes §6.3 *and* a Plane match |

**Deliberately NOT renamed:** Workspace, Project, Members, Labels, States,
Priority (and its five values), Assignees, Comments, Activity, Estimates,
Automations, Webhooks, Exports, List, Board, Calendar, Home, Projects, Settings.
These are the shared vocabulary of the whole category. A tool that renames
"Assignee" is not differentiated, it is annoying.

---

## 5. Proposed structural / model changes

### 5.1 Replace the feature-toggle grid (fixes S1)

Delete the toggles. Surface a primitive in the sidebar when the project actually
has one of that thing, plus a persistent "+". Zero configuration, and it removes
the five near-identical "X is disabled for this project" screens
(`CyclesPage.tsx:56`, `ModulesPage.tsx:100`, `ProjectViewsPage.tsx:284`,
`PagesPage.tsx:209`, `IntakePage.tsx:208`).

If toggles must stay, invert the framing from "features you enable" to a project
*template* chosen at creation — which `CreateProjectModal` already half-implements.

**Cost:** medium. Project schema + migration, `CreateProjectModal`,
`Features.tsx` (deleted), `Sidebar.tsx`, five guard blocks.

### 5.2 Collapse Cycles + Modules into one primitive (fixes S2)

The strongest structural fingerprint (§3.3 S2 — a six-value status enum matching
Plane's documented module lifecycle word for word), and independently a source of
user confusion: `WorkItem` forces a choice between `cycleId` and `moduleId` for
work that is naturally both.

**Proposal — one grouping, optionally time-boxed.** A single **Track** with
`name, description, leadId, memberIds, startDate?, endDate?, status`. With dates
it behaves as today's cycle (burndown, active/upcoming/completed); without them
as today's module. `WorkItem.trackIds: ID[]` replaces both scalar FKs, so an item
can sit in "Q1 Launch" and "Payments" simultaneously — which today it cannot.

**Alternative (lower cost, higher differentiation):** keep two primitives, but
make one agent-native — Tracks own an `agentId` and a standing brief, so a track
*is* the unit of work you hand to an agent. Differentiates by addition rather
than deletion.

**Cost:** high. Schema migration, both page trees, group-by, search, webhooks,
Recents, burndown. **The one item here that needs a product decision, not a
ticket.**

### 5.3 Remove `triage` as a state group (fixes S3)

Drop to the five-group core. A ticket promoted from a Request lands in `backlog`
and carries a `source` field; "needs triage" becomes a saved filter
(`source = request AND state.group = backlog`), not a sixth group. Note this
moves Waypoint *further* from Plane, not closer — Plane keeps a Triage state,
just outside the group taxonomy (§3.3 S3).

Also removes live debris: `STATE_GROUP_ORDER`, `StateIcon`'s `Inbox` case, the
orphan `triage: 0` counter in `cycle-utils.ts`, and a seeded state per project.

**Cost:** low-medium; net simplification.

### 5.4 Rework Requests as agent-triaged (fixes S4 — and differentiates)

The highest-leverage place to convert a collision into a differentiator. Waypoint
already has an agent that can read the repo, a Bug Triage starter template
(`agentTemplates.ts:53`), an `on-label` trigger, and a propose→approve loop. Wire
them together: an incoming Request is picked up by the triage agent, which reads
the repo, searches existing tickets, and produces a *proposal* — "duplicates
WAY-88", or "this is real; here is a drafted ticket with suggested state,
priority, and the three files involved" — that a human approves in one click.

That reframes the queue from "a form non-members submit to" (Plane's model, and
a Business-tier feature there) into "the front door where the agent does the
first pass" (nobody's model). Same screen; different product claim.

**Cost:** medium-high, but net-new differentiating work.

### 5.5 Promote the agent surface into primary IA

The differentiator is invisible: Agents at `/settings/agents`; Codebase at
`/projects/:id/settings/codebase`; Copilot behind `COPILOT_ENABLED`; Sessions
behind a second flag. Meanwhile Stickies — a Plane feature name — holds a
permanent top-level slot.

- Add a top-level sidebar entry **Agents** (or **Crew**) above Projects.
- Move Codebase out of settings into the project header as a persistent status
  chip: *"Repo linked: ~/src/waypoint"* / *"Link a repo"*. It gates the flagship
  feature; it should not be four clicks deep.
- Demote Stickies into Home (where it already renders) and off the sidebar —
  which simultaneously breaks the §3.2 sidebar sequence match.
- Ship Copilot unflagged.

**Cost:** low. **Highest value-per-hour item in this document.**

### 5.6 Simplify estimates (fixes S5)

Low priority. Either leave it, or reduce `estimatePoints`/`estimateValue` to a
single `estimate: string | null` interpreted by the project's system — simpler
than the copied model regardless of differentiation. Rename per §4 #16.

### 5.7 Delete the Instance admin surface (fixes S7)

Delete `pages/admin/` entirely. If anything survives, it is one or two rows in
Profile → Preferences (telemetry opt-out) — where a desktop app puts them.

**Cost:** low, and a net deletion of ~500 lines of dead UI. Removes the clearest
structural evidence of provenance in the codebase.

### 5.8 Rewrite the copied prose (fixes S8)

Phase 0. `Features.tsx:14-36`, `Automations.tsx:122-131`, plus a review pass over
every empty state and settings description. Write them in Waypoint's own voice —
which, given the product, should talk about tickets, repos, and agents rather
than about "sub-projects with dedicated leads".

### 5.9 If §5.2 is deferred, still change `WorkModule.status`

The six-value enum match (§3.3 S2) is the tightest data-model collision in the
audit and is independently fixable in an afternoon. Even if the Cycles/Modules
merge is postponed indefinitely, collapse this to something Waypoint chose —
e.g. `planned | active | paused | done | dropped`.

---

## 6. Independent UX gaps

Found while reading. **None of these are about Plane** — they are defects, dead
affordances, and inconsistencies that should be fixed on their own merits.

**6.1 — "New work item" always files into the wrong project. [bug-grade]**
`layouts/Topbar.tsx:326` computes `const firstProjectId = projects?.[0]?.id` and
passes it to `CreateWorkItemModal` at line 437. The topbar's primary action
therefore always files into whichever project sorts first — *even while you are
looking at a different project*. A `useCurrentRouteProject` hook (written for
Copilot) already solves exactly this. **Highest-severity item in this section.**

**6.2 — Sidebar "Views" opens a page titled "All work items".**
`Sidebar.tsx:137` labels `/views` as "Views"; `WorkspaceViewsPage.tsx:46` renders
"All work items" over a flat cross-project table. Not a views feature at all, and
it collides conceptually with the project-level Views two lines above. Either
build workspace saved views or relabel the nav item.

**6.3 — Notifications vs. Inbox.** Bell and route say Notifications;
`Notifications.tsx:79` renders "Inbox". Two names for one screen — and "Inbox" is
also Plane's name for exactly this feature [verified], so fixing it closes a
collision at the same time.

**6.4 — Favourites are half-built, and one half is fake.** Pages
(`PagesPage.tsx:181`) and Views (`ProjectViewsPage.tsx:275`) persist
`isFavorite` through the API. Cycles do **not** — `CycleListCard.tsx:98` and
`CycleDetailPage.tsx:126` hold favourite state in a local `useState(false)`, so
the star toggles visibly and silently resets on navigation. And there is **no
Favourites section anywhere in the sidebar**, so even the persisted stars have no
payoff. Build the section or remove the stars.

**6.5 — Quicklinks is a dead affordance.** `Home.tsx:241-250` renders an
`EmptyState` unconditionally, promising "Pin projects, pages, or views here for
fast access" — with no way to pin anything. A permanent empty box on the primary
landing screen advertising a feature that does not exist.

**6.6 — Copilot never shows what it can see. [highest-value gap]**
Grounding "follows the open page" (`useCurrentRouteProject.ts`), so the repo the
next message reads changes silently as the user navigates — and the panel header
(`CopilotPanel.tsx:851-864`) shows only the session title. The user cannot tell
which project's repo is in scope, whether a repo is linked at all, or that it
just changed underneath them. The repo-link card appears only *reactively*, after
the model has already failed to find code. For a product whose entire pitch is
"the AI can read your codebase", the absence of a persistent "grounded in:
{project} · {repo}" chip is the biggest UX gap in the app — and it is one
component in the panel header.

**6.7 — "Ticket" vs. "work item".** Agent surfaces say ticket
(`sessions/types.ts:15-17`, `AgentDetailPage.tsx:30`, `CopilotPanel.tsx:958`);
everything else says work item. Rename #1 resolves this in the direction the
differentiating surfaces already chose.

**6.8 — One keyboard shortcut in a native desktop app.** `⌘K` for search is the
only global binding (`Topbar.tsx:330`). No `⌘/` help, no new-ticket shortcut, no
`j`/`k` list navigation. The README headline is "actually ships as a native
desktop app"; shortcuts are the cheapest way to make that felt.

**6.9 — The admin AI page configures the wrong vendor.** `pages/admin/AI.tsx`
collects an **OpenAI** key and offers GPT-4o / GPT-4o mini, while the real
Copilot runs on the user's local Claude subscription
(`ExecutionMethod = 'local-claude-subscription'`). Contradictory and
non-functional. Resolved by §5.7.

**6.10 — No work-item relations.** `WorkItem` has `parentId` and nothing else —
no blocks / blocked-by / duplicates / relates-to. Plane ships six relation types
[verified: Blocking, Blocked By, Relates To, Duplicate Of, Starts Before,
Implements], and every serious competitor has some version of this. Waypoint's
own Intake even has a `duplicate` status with nowhere to record *what* it
duplicates. A genuine missing affordance, independent of everything else here —
and note that adding relations is one of the few places where following the
category is correct rather than derivative.

**6.11 — Drafts cannot be resumed.** `Drafts.tsx:50` links each draft to
`/projects/{projectId}/work-items` — the list, not the draft. The page's own copy
promises "so you can pick up where you left off". You cannot.

**6.12 — Two near-identical "add to grouping" modals.**
`CycleWorkItemList.tsx:56` ("Add work item to cycle") and
`ModuleDetailPage.tsx:132` ("Add work item to module") are parallel
implementations of one picker. Collapses to one component if §5.2 lands.

**6.13 — Five copies of the same "feature disabled" empty state.** Listed in
§5.1. Even if the toggles stay, this should be one shared component.

**6.14 — No shared menu/dropdown primitive.** `Topbar.tsx:38-40` documents this
explicitly ("there's no shared Dropdown/Menu primitive in `src/components/ui/`
yet"), and the pattern is then reimplemented locally in at least seven files
(`Topbar`, `Home`, `CycleListCard`, `CycleDetailPage`, `ProjectViewsPage`,
`ModuleDetailPage`, `PagesPage`), each with its own click-outside and Escape
handling. A consistency and accessibility risk, not just duplication.

---

## 7. Prioritized rollout

### Phase 0 — Copy purge (days) · **do this first, unconditionally**

Independent of every other decision here.

- `pages/project-settings/Features.tsx:14-36` — all five descriptions.
- `pages/project-settings/Automations.tsx:122-131` — both descriptions.
- A review pass over every `EmptyState` description and settings subtitle. I
  checked the obvious ones; a full sweep by someone with Plane open would be
  prudent.

Cheap, zero product risk, removes the only finding with real exposure.

### Phase 1 — The rename batch (1–2 weeks) · ship as ONE change

All of §4 together, for the reason in §3.2.

Includes UI strings, route paths, component/file names, the `ProjectFeatures`
key migration, and:

- **Webhook event renames** (#22–23). This is an external contract. Ship both
  old and new names for one release, or accept the break if there are no external
  consumers yet — decide explicitly rather than by omission.
- **MCP tool renames** (`list_work_items` → `list_tickets`, etc.). These are
  consumed by the Copilot runtime's own system prompt
  (`src/main/copilot/copilotRunner.ts`), so rename the prompt text in the same
  commit or the agent breaks.
- The `#10` Network→Visibility fix (§3.4 — highest evidence value), the `#38`
  Inbox→Notifications fix, and `#36` `WorkModule.status`, all of which double as
  UX or evidence fixes.

Low risk, high fingerprint removal, mostly mechanical.

### Phase 2 — Cheap IA and defect fixes (1–2 weeks) · parallel with Phase 1

- §5.5 promote Agents / Codebase / Copilot into primary IA — **highest
  value-per-hour in this document**, and it breaks the sidebar sequence match.
- §5.7 delete `pages/admin/` (net deletion).
- §6.1 topbar create-in-current-project (bug).
- §6.6 Copilot grounding indicator (differentiator visibility).
- §6.2, §6.3, §6.5, §6.11 label and dead-affordance fixes.
- §6.4 decide favourites: build the sidebar section or remove the stars.
- §6.13, §6.14 shared components.

### Phase 3 — Structural changes (need product decisions)

Ascending cost:

1. §5.9 change `WorkModule.status` — hours; do it in Phase 1 if possible.
2. §5.3 remove `triage` as a state group — low, reduces complexity.
3. §5.1 replace the feature-toggle grid — medium.
4. §5.6 simplify estimates — low, optional.
5. §5.2 **collapse Cycles + Modules** — high cost, high fingerprint value, and a
   genuine product decision. Do not start until someone has decided whether
   Waypoint wants one grouping primitive or two.

### Phase 4 — Differentiation (the actual product work)

- §5.4 agent-triaged Requests.
- §6.10 work-item relations.
- §6.8 a real keyboard-shortcut layer.
- Unflag Sessions once there is a runtime behind it.

---

## 8. On visual identity — do not redesign

Asked directly: **is a distinct visual identity needed?** No, and spending effort
there would be a mistake.

**Waypoint is already visually distinct from Plane.** The monochrome accent
(§2.12) is an unusual and confident choice that no competitor in this category
makes — Plane, Linear, Jira, Height and Asana all lead with a saturated brand
hue, and Plane's own release notes describe tuning colour to "signal meaning"
[verified], i.e. the opposite direction. Space Grotesk over Public Sans is a
distinctive pairing. The 6/10/16px radius ladder, 14px body, thin scrollbars and
palette-inverting boot splash are coherent and deliberate. A Plane user would
recognise Waypoint's *nouns* instantly; they would not mistake its *appearance*.

**Both products use Lucide** [verified for Plane; `lucide-react` in 58 Waypoint
files]. This is not a finding — Lucide is the default open-source icon set for
React apps in this era, and shared dependencies are not shared identity. It is
worth *one* check, though: whether Waypoint picked the same specific glyphs for
the same specific concepts (`RefreshCw` for cycles, `Boxes` for modules, `Layers`
for views, `Inbox` for triage). Same library is convergence; same glyph choices
across six concepts would be another axis of §3.2. **[unverified — needs
someone with Plane open.]**

**The layout and density similarity is category convergence, not copying.** A
256px sidebar, a 48px topbar with search, a peek drawer and five layout tabs
describe Linear, Height, Jira's current UI, Shortcut and Plane equally. That is
what good project-management software looks like in 2026. Changing it would cost
real usability and buy nothing.

**The one visual gap worth closing** is that the product does not *look* like it
has an AI teammate in it. The agent surfaces reuse generic chrome — a `Sparkles`
icon, a `Bot` icon, standard badges. Any visual investment should go into giving
agents, proposals, and repo-grounding a distinct treatment (agent-vs-human
distinction in avatars and activity feeds, a recognisable proposal-card language,
the persistent grounding chip from §6.6) rather than into re-theming the tracker.

The `Compass` mark (`Sidebar.tsx:82`) is currently the only asset carrying the
product's own metaphor, at 14px. If §4's Navigational column is adopted, that
metaphor has room to grow into iconography for Legs, Tracks and waypoints —
genuine ownable visual differentiation *earned from the naming system* rather
than bolted on.

---

## Appendix A — Rename checklist by file

For Phase 1 execution. Exhaustive on *locations that define* user-facing names;
not on every string occurrence.

| File | What changes |
|---|---|
| `types/entities.ts` | `ProjectFeatures` keys; `StateGroup` (drop `triage`); `Network`→`Visibility`; `WorkModule.status` values; `WebhookEventType` values; `ActivityVerb` values; `Cycle`/`WorkModule` interface names; `WorkItem.{moduleId,cycleId}` |
| `router.tsx` | `/work-items`, `/cycles`, `/modules`, `/pages`, `/intake`, `/your-work`, `/stickies` + imports |
| `layouts/Sidebar.tsx` | sub-nav labels (39–46); top group (92–115); bottom group (136–153) |
| `layouts/Topbar.tsx` | "New work item" (360); search placeholder (249); result groups (209–215); empty-search copy (265) |
| `pages/Home.tsx` | `RECENTS_FILTER_OPTIONS` (30–36); `RECENT_TYPE_ICON` keys (127); quickstart copy (133); "Your stickies" (254) |
| `pages/work-items/WorkItemsLayout.tsx` | `GROUP_BY_OPTIONS` (42–49); breadcrumb (110); "Add work item" (222). **`VIEW_TABS` (34–40) unchanged — §3.6** |
| `pages/work-items/WorkItemDetailPage.tsx` | property labels; "Sub-work items" (776) |
| `pages/work-items/useWorkItemsView.ts` | `GroupBy` union |
| `components/domain/StateIcon.tsx` | `STATE_GROUP_LABEL`; `STATE_GROUP_ORDER` (drop `triage`); remove `Inbox` case |
| `components/domain/CreateProjectModal.tsx` | feature rows (22–50) |
| `components/domain/CreateWorkItemModal.tsx` | "Work item title" placeholder |
| `pages/project-settings/ProjectSettingsLayout.tsx` | `NAV_GROUPS` labels incl. "Work Structure"; consider reordering to perturb the §3.3 S6 sequence |
| `pages/project-settings/Features.tsx` | labels **and descriptions (Phase 0)** |
| `pages/project-settings/Automations.tsx` | titles **and descriptions (Phase 0)** |
| `pages/project-settings/Estimates.tsx` | `ESTIMATE_PRESETS` labels (#16) |
| `pages/project-settings/General.tsx` | "Network"→"Visibility" (#10) |
| `pages/project-settings/States.tsx` | group headers via `STATE_GROUP_LABEL` |
| `pages/workspace-settings/WorkspaceSettingsLayout.tsx` | "Billing and plans" (#17) |
| `pages/workspace-settings/Webhooks.tsx` | `EVENT_TYPES` (12–18) |
| `pages/Notifications.tsx` | heading "Inbox"→"Notifications" (79) |
| `pages/WorkspaceViewsPage.tsx` | heading, or the sidebar label (§6.2) |
| `pages/ProjectsList.tsx` | network filter copy (91) |
| `pages/AnalyticsPage.tsx` | stat-tile labels (83–88) |
| `pages/{Cycles,Modules,Pages,Intake,ProjectViews}*.tsx` | headings, empty states, modal titles, "disabled for this project" copy |
| `pages/cycles/*` | `NewCycleForm` placeholder "e.g. Sprint 12"; `cycle-utils.ts` `BREAKDOWN_ORDER` / `Breakdown` (drop `triage`) |
| `pages/sessions/types.ts` | already says "ticket" — becomes consistent, no change needed |
| `lib/recents.ts` | `RecentType` union |
| `mock/api.ts` | `listAllCycles`, `listAllModules`, etc. |
| `waypoint-backend/src/db/schema/{modules-cycles,intake,work-items,projects}.ts` | tables/columns + migration |
| `waypoint-backend/src/routes/{cycles,modules,intake,workItems}.routes.ts` | route paths |
| `waypoint-backend/src/services/projects.service.ts:63-68` | seeded state names (drop Triage) |
| `waypoint-backend/src/db/seed.ts:198-203` | same |
| `waypoint-backend/src/mcp/workItemTools.ts` | tool names + descriptions |
| `waypoint-frontend/src/main/copilot/copilotRunner.ts` | system-prompt vocabulary — **must land in the same commit as the MCP rename** |
| `README.md` | product-description vocabulary |

## Appendix B — Open questions

**Resolved by this audit's research** (was uncertain, now [verified]): Plane's
current primitive names; the five state groups and their default state names;
priority values; the five layout names (which forced the §3.6 correction); the
sidebar order; the project-settings section order; the estimate type names; the
relation types; the tier ladder; Lucide as the icon library.

**Still open:**

1. **[unverified]** Are `backlog/unstarted/started/completed/cancelled` Linear's
   state types, adopted by Plane rather than invented by it? §3.3 S3's risk
   assessment turns on this. If yes, that collision is much weaker.
2. **[unverified]** Is `network` the field name in Plane's own schema? §3.4 is
   the sharpest evidence in the audit and rests on this. Checkable against
   makeplane/plane.
3. **[unverified]** Do Plane's Home widgets still read Quicklinks / Stickies /
   Recents, in that order? Stickies is confirmed; the arrangement is not.
4. **[unverified]** Icon-glyph-level match (§8) — same Lucide glyphs for the same
   six concepts?
5. **[unverified]** Are the exact strings in §1.1 currently live in Plane's
   product? My confidence they originated there is high but not absolute — and
   Phase 0 should happen regardless, since they are mediocre copy on their own
   merits.
6. **[product decision]** §5.2 — one grouping primitive or two? Everything in
   Phase 3 waits on this.
7. **[product decision]** §4 — Navigational or Neutral column? Pick per cluster,
   commit once.

## Appendix C — Plane research sources

Fetched September 2026. Claims tagged **[verified]** trace to these:

- plane.so · plane.so/pricing
- docs.plane.so/introduction/core-concepts
- docs.plane.so/core-concepts/issues/{states,properties,layouts,estimates,epics,timeline-dependency}
- docs.plane.so/core-concepts/{views,cycles,modules,inbox,stickies,drafts}
- docs.plane.so/core-concepts/projects/{overview,initiatives,milestones}
- docs.plane.so/core-concepts/workspaces/{overview,teamspaces}
- docs.plane.so/{your-work,intake/overview,releases,customers,dashboards,analytics}
- docs.plane.so/workspaces-and-users/roles
- docs.plane.so/work-items/project-work-item-types
- github.com/makeplane/plane — releases, PR #6578 (sidebar revamp), PR #6543
