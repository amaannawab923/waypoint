# Waypoint onboarding — three options, compared

Companion to `onboarding-option-a.html`, `onboarding-option-b.html`, `onboarding-option-c.html`
(clickable walkthroughs, one screen per moment in the journey). This is the side-by-side read:
where each option is strongest, where it's weakest, and what it costs to build.

All three share the same underlying commitment from the research
(`docs/product/pm-research-accounts-onboarding.md`, Approach C) and design doc
(`docs/design/waypoint-accounts-and-teams.md`): Personal is fully local with no sign-in gate,
Team is a real hosted multi-tenant workspace, and the fork happens somewhere other than a
mandatory pre-mount sign-in screen. What differs between A/B/C is *when identity is asked for*
and *how the invite path is discovered* — the two levers that trade off drop-off against
discoverability.

## A. Quiet Invite
Zero-account start. A persistent "Invite your team" link lives in the sidebar footer from the
first launch, plus a contextual second entry point in the Assignee field. Identity is asked for
only at the moment Invite is clicked.

## B. Soft Start
One optional, equal-weight identity screen at first launch ("What should we call you? — Skip,
just me"). Invite discovery adds a one-time milestone-triggered nudge banner on top of the same
persistent sidebar link, so the prompt is proactive once, not only passive.

## C. Invisible Workspace
A real workspace-of-one is created silently on first launch, but no UI ever says "workspace"
until it matters. There is no persistent invite affordance at all — the prompt surfaces inline,
exactly once, the first time a solo action implies a second person (assigning a ticket to a name
that isn't you; @-mention and session-share are the same pattern, not shown as separate steps).

---

## Comparison table

| | **A · Quiet Invite** | **B · Soft Start** | **C · Invisible Workspace** |
|---|---|---|---|
| **Drop-off — first launch** | Lowest. No screen, no field, identical to a no-account app. | Low-moderate. One optional field with an equal-weight skip; some principled bounce even at near-zero friction. | Lowest, tied with A. Identical surface to A; the real cost is deferred, not avoided. |
| **Drop-off — first value** | Low. Home leads with one clear action; ticket/Jira connect in seconds. | Low. Same Home, same action — reached one screen later. | Low. Identical to A. |
| **Drop-off — invite discovery** | Moderate. Relies on the user noticing a sidebar-footer link or typing a non-self name into Assignee. | Lower than A for users who stick around: a milestone nudge actively offers it once, on top of the same passive link. | Highest of the three. No passive surface at all — discovery depends entirely on the user doing one of a handful of specific actions (assign to another name, @-mention, share a session). A solo user who never does any of these may never see Team mode. |
| **Drop-off — invite click** | Low-moderate. Full modal, two fields (name + team name), clear local/hosted note. | Lowest. Often one field only (team name), since identity was captured at launch. | Low-moderate, same shape as A, but the first-ever use of "workspace" language happens right here — a small trust-check moment the copy has to carry cleanly. |
| **Drop-off — invitee join** | Low. One link, one field, works in-browser, deep-links to the app. | Low. Identical mechanism to A. | Low. Identical mechanism, but lands the invitee directly on the ticket that brought them in (ROAD-127) rather than an empty board — slightly stronger first-value for the invitee specifically. |
| **Infra cost starts** | At first Invite click — zero cost for every solo download. | At first Invite click — identical to A. The optional identity field is stored locally; no hosted cost until Invite. | At first Invite click — identical to A and B. The workspace-of-one is local-only storage, not hosted infra, until someone else joins it. |
| **Engineering scope to launch** | Smallest of the three. One persistent sidebar affordance + one Assignee-field hook + the invite modal + hosted workspace provisioning (shared across all three options). | A plus one optional first-launch screen (name capture, skip state, local persistence) and one milestone-detection rule (e.g. "5 tickets closed") to trigger the nudge once. | A's invite-modal/provisioning work, plus per-surface trigger logic in every place a "name that isn't you" can appear (Assignee, @-mention, session-share) — more surfaces to instrument than A or B, even though the entry UI itself is simpler. |
| **Favors** | The purest solo persona — anyone who would bounce at *any* pre-Home friction, and power users who already know where to look for things in a sidebar. | The average solo user who's fine giving a name if asked nicely, and who benefits from being proactively reminded once they've built a habit — likely the best-converting option for solo→team specifically. | Teams that form around a specific piece of work rather than a general "let's use this together" decision — e.g., assigning a bug to a teammate. Best fit if the founder wants the tool to feel like solitaire until it isn't. |
| **Honest weakness** | The sidebar link is easy to overlook if the user never scrolls to the footer or never assigns a ticket to someone else — habit alone doesn't guarantee the loop fires, only makes it possible. | The extra first-launch screen is real, measurable friction versus A for the "I will not click through anything" segment, even though it's small and skippable. | Discovery is the weakest of the three by a real margin — it depends on specific solo behaviors happening at all. A user who works entirely alone, never assigns tickets to anyone, never @-mentions, never shares a session, has *no* path to discovering Team mode. This is a genuine, not theoretical, dead-end risk for part of the target audience. |

---

## Recommendation

**Option B, with A's sidebar link kept as the permanent fallback.**

Reasoning: B and A have essentially identical first-launch and first-value drop-off (the skip
button makes B's extra screen close to free), but B adds a second, *active* discovery
mechanism — the milestone nudge — without removing A's *passive* one. C's mechanism is the most
elegant in isolation (nothing to notice, nothing to ignore, shows up exactly when relevant) but
its discovery risk is structural, not just a tuning problem: some real fraction of the target
solo audience will never trigger it, and for those users the growth loop the founder identified
as the whole point ("habit → invite the team") simply doesn't exist. That's a risk worth taking
for a product that has to convert habitual users into team accounts to grow, only if C's trigger
surface is deliberately widened well beyond one field — which is itself more engineering, not
less, undercutting the "invisible = simple" intuition.

B's one soft field also pays for itself downstream: it's the only option where the *invitee*
sees a fully personalized invite ("Amaan invited you...") without Amaan having had to type his
own name a second time at the exact moment he's least likely to want to.

## Product decisions the founder still has to make

1. **Does an invited ticket's data (or the whole ticket list) move to the hosted workspace, or
   does the hosted workspace start empty and get populated separately?** Every option above
   assumes "only what you explicitly invite people onto" (A/B: the whole new team workspace
   starts empty and existing local tickets never auto-migrate; C: literally just the one ticket
   being assigned). This is the same open question flagged unresolved in
   `waypoint-accounts-and-teams.md` §6 and `pm-research-accounts-onboarding.md` §4.3 — it still
   isn't resolved here, but the UX in all three mockups needs a firm answer before build, because
   the modal copy ("Stays local: ROAD-127 and everything else... Goes hosted: only this new
   workspace") is a promise the backend has to actually keep on day one.
2. **Is a milestone-triggered nudge (Option B) something the founder wants to commit to
   instrumenting before launch, or is "just the sidebar link" (Option A) an acceptable v1 with
   the nudge as a fast-follow?** The nudge requires picking and shipping a real trigger condition
   (ticket count? session count? days active?) — a small but real product decision, not just a
   UI toggle.
3. **For Option C specifically, if any part of it survives into the final direction: which solo
   actions should carry the invite trigger, and is instrumenting all of them (Assignee field,
   @-mention, session share) worth doing, or does the founder accept C only with a single trigger
   and the discovery risk that comes with it?** This decides whether C is a real contender or a
   reference point for "what not to under-scope."
