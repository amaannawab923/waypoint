# Provider configuration UX v2

Design pass against `docs/design/provider-configuration.md` (the architecture)
and `docs/design/phoenix-provider-architecture.md` (the Phoenix study), written
2026-09-26 after driving Phoenix live at `localhost:6006` (`/settings/providers`,
`/settings/agents`), reading Phoenix's source at
`/private/tmp/claude-501/.../scratchpad/phoenix` for inspiration only, and
reading the shipped Waypoint code end to end: `Providers.tsx`, `Copilot.tsx`,
`ProfileSettingsLayout.tsx`, and every file under `src/main/providers/`.

**License note, stated once:** Phoenix is Elastic License 2.0. Nothing below
transcribes its source, copies a component, or reuses its literal strings.
Layout, IA and vocabulary are studied and re-derived from our own constraints;
every place this doc says "like Phoenix," it means the *pattern*, independently
rebuilt against our data.

Supersedes `provider-settings-mockup.html`, which was built for a hide-the-CLI
requirement that is no longer in scope (§4.3 below).

---

## 0. What "missed badly" actually was

Reading the shipped code rather than trusting the summary changed the
diagnosis in two places, worth stating before the fix:

- **The five defects are real, but the file is not cards.** `Providers.tsx`
  already renders flex rows in five tiered sections — the right skeleton.
  What actually reads as "cards filling the screen" is *row height*: every
  row carries a two-line blurb, a two-line status, and (for multi-method
  providers) two full-width sentence buttons stacked vertically once they
  wrap. Confirmed live — at 1024px the Claude Code row's two sign-in buttons
  overflow the viewport exactly as described. The fix is density, not a
  rewrite of the section structure, which §5 below keeps.
- **Defect #5 is worse than stated.** The task brief says Claude lists 3
  models where the plugin has 5, and flags one wrong id. Reading
  `packages/plugins/src/agents/impl/{amp,mistral}/index.ts` directly: Amp and
  Mistral aren't under-counted, they're **fabricated**. Amp's real model keys
  are effort tiers — `low` / `medium` / `high` / `ultra` — not the invented
  `amp-sonnet-5` / `amp-opus-5` / `amp-gpt-5.1`. Mistral's real keys are
  `mistral-medium-3.5` / `devstral-small` / `local`, not the invented
  `mistral-large-3` / `mistral-medium-3` / `codestral-3`. Antigravity's 8 real
  entries are also keyed by their display name, not a slug id
  (`'Gemini 3.5 Flash (Medium)'` *is* the key). None of this is a rendering
  bug; §5 treats it as the highest-priority fix because it is orthogonal to
  everything else and every other screen in this doc is drawn against the
  corrected data.
- **Defect #2's "stub" is one stub answering for two different things.**
  `providersIpc.ts`'s `beginCliLogin` is honestly documented as unwired. But
  `ProviderRow`'s `trySignIn` routes *every* non-`api-key` method through it —
  including the Copilot's `subscription-token` method, which is not a
  `cli-login` at all and already has a real, working implementation
  (`CopilotConnectModal`, driving `claude setup-token` in a real pseudo-
  terminal, live today on the Copilot page). So the Copilot row doesn't just
  hit an honest "not wired up yet"; it bypasses code that already works. §5
  treats this as two bugs sharing one symptom, not one bug.

---

## 1. Page structure — disagree with nesting, ship what's already there

**Verdict: disagree with the founder's suggestion. Keep Providers and Copilot
as siblings, exactly as `ProfileSettingsLayout.tsx` already has them today.**
This isn't a new proposal — it's declining to undo a decision the codebase
already made correctly, and confirming it with a reason stronger than "Phoenix
does it this way."

**Why nesting breaks, specifically:**

1. **Providers already has a second consumer waiting.** Per
   `provider-configuration.md` §5 step 5, coding sessions are meant to read
   the same `ModelSelection` catalog the Copilot does — `workspaces.default_agent_provider`
   is already wired end to end for sessions, just not yet fed by this UI. If
   the 35-provider table lived inside Copilot settings, a user signing in to
   Claude Code *to run a coding session* would have to go find it under
   "Copilot" — a page about the in-app assistant, which coding sessions never
   touch. That's a wrong mental model baked into the IA, not a cosmetic
   nit.
2. **The architecture doc already ruled on this and reversed itself once.**
   §4.1 of `provider-configuration.md` records that the *first* draft proposed
   building Settings around the Copilot specifically because it's the
   smaller, safer surface — then rejected its own proposal, because the
   Copilot is "a degenerate case of every field the abstraction needs" (no
   real `installed` probe, no real `cli-login`, always one vendor). Nesting
   the general table inside its most restricted consumer's settings page
   repeats the mistake that draft already corrected in code; this doc just
   makes the same call in the UI.
3. **Nesting recreates the crowding directly.** `Copilot.tsx` today already
   mixes Copilot-specific behavior (browser access, floating button) with
   provider mechanics (`ClaudeCodeStatus`, `CopilotConnectModal`, manual
   token paste) on one `max-w-lg` page. Adding a 35-row table on top of that
   is the crowded-cards failure mode again, just relocated one level down.
4. **Phoenix's own structure is the evidence for separation, not against
   it.** Phoenix runs 17 fully-described providers and keeps its Assistant
   page down to one model dropdown and one sentence. Waypoint has 35 providers,
   most far less describable than Phoenix's — nesting would mean *more* provider
   surface crammed into the assistant page than Phoenix ever tolerated, not less.

**Structure shipped:**

```
Profile settings
├── Copilot         (existing nav item — unchanged position)
│     one model picker (Anthropic only) + delegation sentence
│     + Copilot-only behavior (browser access, autonomy, chat retention)
│     — NO connect/disconnect mechanics anymore (moved out, see §2)
└── Providers        (existing nav item — unchanged position)
      the table (§3) — every provider, every credential, every model list
      the Copilot's native row lives HERE, including its connect flow
```

Net effect on the file tree: `Copilot.tsx` gets *smaller* (loses
`ClaudeCodeStatus`, `CopilotConnectModal` wiring, the manual-token flow, the
`copilot.auth.*` status polling — those relocate to the Copilot row inside
`Providers.tsx`/`nativeProviders.ts`), and `Providers.tsx` gains one row that
already has working connect/disconnect code to reuse rather than build.

---

## 2. The Copilot tab

**What it holds**, top to bottom:

1. **Title + one-line purpose sentence.** Unchanged from today.
2. **One dense overview line**, Phoenix's `/settings/agents` density —
   `gemini-3.7-flash` sitting next to one sentence, not a card — adapted to
   what the sentence has to say given the Copilot is single-vendor:

   > **Claude Sonnet 5** · Signed in via Claude subscription
   > *Providers and credentials are managed in [AI Providers →]*

   When not connected, the same line reads `Not signed in` and the link is
   the only affordance on the page for it — no button here, matching Phoenix's
   own rule exactly: the assistant page never offers to fix a credential
   problem itself, it points at the page that owns credentials.
3. **The model picker.** A single dropdown, Anthropic models only (§2.1 below
   on why no Recommended/Other split). Disabled with a tooltip
   ("Sign in on AI Providers first") when not connected — never hidden,
   since hiding it would make the page's one real control disappear
   depending on state.
4. **Copilot-only settings**, unchanged in substance from today's page:
   "Let Copilot use my Chrome" (browser access), autonomy/approval mode,
   floating vs. pinned button, start chats as temporary. These stay because
   they're behavior controls over the assistant, not credentials — the same
   line Phoenix draws between its Assistant page's toggles and its AI
   Providers page.

**What moves out:** `ClaudeCodeStatus`, `CopilotConnectModal`'s trigger,
the manual-token-paste fallback, and the `copilot.auth.status/save/clear`
polling. All of it relocates to the Copilot's row in the Providers table
(§3) — the code doesn't get rewritten, `CopilotConnectModal` is reused
unmodified, only its call site moves. This is the concrete fix for defect #2
(§5): the Copilot's real connect flow becomes reachable from the row that
represents it, instead of a stub that never should have been in the path.

### 2.1 Does Phoenix's Recommended/Other split earn its keep here?

**No, not at our scale, and not in the shape Phoenix uses it.**

Phoenix splits *because* it has hundreds of models across many vendors and
needs a curated "don't make the user read the whole list" head. We have
roughly 20 models across 5 providers *total*, and the Copilot itself sees
only its own ~5 Anthropic ids — a flat list is already shorter than
Phoenix's "Recommended" tier alone. Reintroducing a popularity split on a
5-item list is a control for a problem we don't have.

Where the idea *does* transfer, in a different shape: **group by vendor
label, not by recommendation, and only where a single provider spans more
than one vendor.** Antigravity's own 8-model list already crosses three
vendors inside one row (Gemini, Claude, GPT-OSS) — that list benefits from
Phoenix's "grouped, not flat" instinct, with the group header being the
underlying model vendor, never "Recommended." Claude Code's, Codex's, and
the Copilot's lists are each single-vendor and stay flat. This is a
narrower, provider-shaped version of Phoenix's idea, not its rejection.

---

## 3. The Providers table

One `<table>`-shaped list (visually — implementation can stay `div`-based
like today's `ProviderRow`, the constraint is row height and column
alignment, not the DOM tag), five sections in the tiering already shipped in
`tiering.ts` — validated as correct and kept unchanged:

| Section | Shown when |
|---|---|
| Always on | `native` — today, only the Copilot |
| Configured | declares auth, `status === 'ok'` |
| Ready to configure | declares auth, not yet signed in |
| Models known, sign-in not available yet | models declared, no auth declared (Antigravity, Amp, Mistral) |
| More providers Waypoint doesn't support yet | neither declared — 29 rows, collapsed |

**Columns:**

| Column | Content |
|---|---|
| **Provider** | icon (generic per-vendor mark) + name, blurb only if declared (never invented — the 29 long-tail rows and the two Tier-B rows with no blurb get none) |
| **Status** | one badge, collapsing installed × signed-in (§4.2) |
| **Credentials** | see below — replaces Phoenix's "Environment Variables" |
| **Models** | live picker when actionable, else a plain summary — never a bare count (fixes defect #4) |
| *(action)* | zero or one control, right-aligned, single word |

**Status vocabulary** (six states, one dot-plus-word each): `Signed in` ·
`Not signed in` · `Not installed` · `Setting up…` · `Needs your approval` ·
`Something went wrong`. `Sign-in not available yet` is a seventh, distinct
state for Tier B/C — not an error, not a variant of "not signed in," because
nothing was declared to sign in *with*.

**Credentials column — what replaces "Environment Variables":**

- `api-key` method → the env var name(s), monospace, exactly Phoenix's
  pattern (`ANTHROPIC_API_KEY`). Multiple accepted names render comma-joined,
  matching `opencode`'s real three-name declaration.
- `cli-login` method → the method's own label, plain text, no monospace
  (it isn't a machine key): `Browser sign-in`. Two methods (Claude's
  subscription vs. console) render as `Browser sign-in (2 ways)`, expanded
  only in the action's own menu (§3.1) — never two rows for one provider.
- Nothing declared → em dash, muted, identical treatment whether the row is
  Tier B or Tier C. No special copy invented to fill the cell.

**Models column:**

- `selectable`, signed in → the real inline picker, current selection
  shown, opens the shared model-picker surface (§2.1's grouping rule) on
  click.
- `selectable`, not signed in → `N models` as plain muted text, *not* a
  link — clicking it can't do anything useful yet, so it doesn't pretend to.
- `none` → `Uses its own default`.
- `unknown` → em dash.

**The 29 long-tail rows, as table rows, not a different tier:**

Same five columns, same row template, everyone else's row with everything
after Provider rendered as em dash and no action — visually quiet because
the cells are empty, not because the row is a different shape. This directly
answers the brief's question: nothing is redesigned into a collapsed card
tier, it's the literal same table, just with almost every cell holding "—".
They sit behind one disclosure row, **"Show 29 more →"**, at the bottom of
the same table container — collapsed by default (Cline's #14324 is the
reason: 60 providers flat, users scroll past 58 to reach 2), but a search hit
inside the collapsed set auto-expands and highlights that row, so the fold
is about default attention, never about hiding a match from search. This
carries forward reviewer note 9 from the superseded mockup, which still
holds under the new, undecorated visual treatment.

### 3.1 The multi-method action, collapsed to one button

Defect #3's actual cause: `SignInActions` renders one full-width button *per*
auth method, each labelled with the method's own sentence-length description.
Fix: **one button, one word** — `Sign in`, or `Connect key` when the only
method is `api-key` — that opens a small menu when the provider has more
than one method. The menu item text is where the longer method label
belongs (`Claude subscription` / `Anthropic Console (API billing)`), not the
button. This is the whole fix for the 1024px→1448px overflow: the row's
action slot never grows past one button's width regardless of how many
methods a provider declares.

---

## 4. What we do differently from Phoenix, and why

Four deliberate departures, each pinned to a constraint stated in
`provider-configuration.md`, not to taste:

**4.1 — A table row is allowed to have no button.**
Every one of Phoenix's 17 rows is actionable; it hand-describes its own
providers. Ours comes from 35 CLI plugin manifests we don't author line by
line — 29 of them declare neither `auth` nor `models` today. A button on
those rows would have to fail, lie, or shell out to something undocumented;
all three break the one rule this whole surface exists to protect (§2.2 of
the architecture doc: the plugin contract, not this UI, is what's
under-populated). The honest floor is a name and silence.

**4.2 — Status collapses three axes Phoenix never had to combine.**
Phoenix's two badge axes (`dependenciesInstalled`, `credentialsSet`) are
almost this, but "SDK missing" is a quiet background `pip install` failure —
an edge case for Phoenix's users, most of whom never see it. Ours is a
visible CLI binary that may not exist on this machine at all, which per
`provider-configuration.md` §8 sits behind an 11-variant install-error
taxonomy and real OS elevation prompts. "Not installed" isn't an edge case
for us — it's the default first-run state for every provider except the
Copilot. One badge, more states than Phoenix's, because the thing it's
describing is genuinely riskier and more common for us than for them.

**4.3 — No OAuth-popup illusion, no elevation-dialog theater.**
The superseded mockup built a fully-branded fake sign-in window and a
native-looking elevation dialog to hide that a CLI runs underneath, because
product required hiding the CLI at the time. That requirement is gone. This
mockup does what Phoenix does — states plainly what will happen: `Sign in`
opens a real terminal panel (Waypoint already has these, natively) running
the plugin's own login command, unmasked. This is a return to Phoenix's own
honesty, not a new invention — the old mockup was the actual departure, and
this corrects it back.

**4.4 — The model picker's identity boundary is the plugin, never the
vendor.** Phoenix can flatten every model into one cross-vendor list because
Phoenix's provider *is* the vendor. Ours can't: `provider-configuration.md`
§4.3 fixes `ModelSelection.providerId` to the engine plugin id specifically
*because* one plugin (Antigravity) serves three vendors' models under one
sign-in, and two different plugins (Claude Code, Antigravity) can each offer
a model that says "Claude Sonnet" while being gated by two unrelated sign-ins
and billing arrangements. A Phoenix-style flat cross-vendor list at the top
of Providers would silently conflate those. The picker groups by vendor
*inside* a provider's own list (§2.1), never across providers.

---

## 5. Fix order

**Disappear for free in the table rewrite:**

- **#1 (cards, not a table)** — the row-density pass itself. `tiering.ts`'s
  section structure is already right; only row height changes.
- **#4 (model count instead of a picker)** — the Models column becomes the
  live picker described in §3.
- **#3 (sentence-length buttons pushing past 1024px)** — the single-button-
  plus-menu pattern in §3.1 caps the action column's width regardless of
  method count.

**Genuine bugs, fixed regardless of what the row looks like:**

- **#5 (invented catalog)** — pure data correctness, orthogonal to layout.
  Re-transcribe `pluginCatalogData.ts` from the real manifests. This is
  understated in scope, not just severity: Amp's and Mistral's model lists
  aren't under-counted, they're fabricated wholesale (§0), and every screen
  drawn in this doc's mockup uses the corrected data so nothing here quietly
  re-launders the wrong numbers.
- **#2 (Copilot dead-end)** — two separate bugs sharing a symptom (§0):
  `beginCliLogin` is honestly unwired, but `subscription-token` methods
  should never have reached it in the first place — `CopilotConnectModal`
  already works. Moving the Copilot's connect flow onto its Providers row
  (§1, §2) is both the IA fix and the functional fix at once.

**Do first: #5.** It's the cheapest of the five (a data file, no new
component, no state-machine change) and it's a correctness prerequisite for
reviewing every other fix — screenshots of the table rewrite are worthless
evidence if the model lists they show are still invented. Everything else in
this doc's mockup assumes #5 is already done.

---

## 6. Where this can't reach Phoenix's bar, said plainly

Flagged here and again inline in the mockup, per the brief's instruction not
to paper over it:

1. **29 empty rows is not a Phoenix-achievable table.** Phoenix never ships
   a row with nothing to say — every one of its 17 providers is fully
   described because Phoenix wrote every one of them. Our best version of
   this table still has more silence than signal in its long tail; the fix
   for that gap is upstream plugin work (declaring `auth`/`models` for more
   of the 35), not a layout this doc can invent around.
2. **First-run is "Not installed" almost everywhere.** Install flows are
   explicitly out of scope for this pass. The table can show the state
   honestly; it cannot make it go away without the install-flow work
   `provider-configuration.md` §8 scopes separately.
3. **The Copilot's model list can't reach Phoenix's cross-vendor default.**
   Phoenix's assistant can default to any of hundreds of models across every
   configured vendor. Ours is hard-limited to Anthropic because the Copilot
   calls the Claude Agent SDK directly (§4.7 of the architecture doc) — this
   is a real capability gap, not a UI simplification, and the mockup's model
   picker being short is a symptom of that, not a design choice to be proud of.
4. **`cli-login` opening a real terminal is visibly rougher than Phoenix's
   equivalent (nothing — Phoenix has no CLI at all).** §4.3 above frames this
   as a return to honesty, which it is, but "honest" and "as clean as
   Phoenix" pull in different directions here, and this doc is picking
   honest.

---

## 7. Mockup

`docs/design/provider-ux-v2-mockup.html` — self-contained, light + dark, real
copy, drivable end to end:

- Providers table in all five section states, with the corrected catalog
  data transcribed directly from `packages/plugins/src/agents/impl/*/index.ts`
  (read-only reference, per this task's constraint).
- The collapsed 29-row long tail, with working search that auto-expands it.
- The single-button multi-method action (§3.1) on Claude Code's row.
- The Copilot tab: overview line, model picker, delegation sentence, the
  Copilot-only settings retained from today's page.
- A reviewer-notes panel carrying forward §6's four honesty gaps, plus
  anything found only while building the mockup.
