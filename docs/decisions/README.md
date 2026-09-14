# Decisions — accounts, teams, pricing, licensing, launch

Written 2026-09-14, capturing a long founder discussion so it stops living
in a chat thread. Each file is one topic. Each states what was decided, what
was explicitly *un*-decided, and which earlier documents it supersedes.

| File | Topic | Status |
|---|---|---|
| [001-product-shape-and-distribution.md](001-product-shape-and-distribution.md) | What ships on Product Hunt, what "cloud" and "self-hosted" mean, build order | **One open fork** (§3) |
| [002-pricing-and-free-tier.md](002-pricing-and-free-tier.md) | Where free-forever lives, cloud free-tier bounds, prices | Defaults chosen, revisit at 90 days |
| [003-open-source-licensing.md](003-open-source-licensing.md) | AGPL-3.0: what it does and doesn't do, dual licensing, enforcement | Recommendation; needs legal review before publishing |
| [004-launch-readiness.md](004-launch-readiness.md) | What actually gates a Product Hunt launch, in order | Gap list |
| [005-open-questions.md](005-open-questions.md) | Every decision still on the founder's desk, with a default for each | Living list |

## How these relate to the other docs

- `docs/product/onboarding/onboarding-final.html` — the UX flow. Still the
  spec, except where 002 changes copy ("unlimited members" → a seat cap).
- `docs/product/onboarding/monetization-design.md` — the reasoning behind
  the numbers. Decision 2 there is **superseded** by 002 here.
- `docs/design/accounts-teams-architecture.md` — the technical plan
  (ROAD-134 epic, AT1–AT6). Still the plan; 001 §4 reorders AT1.
- `docs/product/research-approach-a-quiet-invite.md` — the research record.

## Rule for editing

Change the decision file, then the spec it governs, then the ticket. Never
the other way round — the ticket is the last thing to reflect a change, not
the first.
