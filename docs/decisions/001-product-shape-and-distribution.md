# 001 — Product shape and distribution

**Status:** decided. §3's fork was called by the founder on 2026-09-14.

## 1. The picture, in plain words

- **Day one:** you download Waypoint and it opens. A working board, Jira
  sync if you want it, AI agents working your tickets. Everything on your
  machine, private.
- **Weeks in:** a small "Invite your team" item has been sitting in the
  sidebar the whole time. Click it, name the team, sign in once with
  Google or GitHub (no password, ever), and a shared team space exists.
  Your personal stuff never moves.
- **Months later:** the only place money shows up is a soft nudge once a
  team has already got real value — "you're past N seats / 30 days of
  history on the free plan." Solo users can add a $5/mo sync add-on from
  Settings, never from onboarding.
- **Underneath:** the code is public on GitHub. Companies with real IT/
  compliance needs can run the team backend themselves. Our cloud is the
  same code, run by us so most people never have to.

One line: *it feels free until a real team is clearly getting value, and
even then the ask is soft, not a wall.*

## 2. What "cloud" and "self-hosted" actually mean

There is **one product**, not two.

| | What it is | Who runs the server | Cost to us |
|---|---|---|---|
| **Desktop app** | The thing on Product Hunt. One download. | Nobody, for personal use (see §3) | Zero |
| **Cloud** | The same team backend, run by us at a waypoint.sh URL. The app points here by default when a team is created. | Us | Real: hosting per team |
| **Self-hosted** | The same team backend, run by a company from the GitHub repo via docker-compose. | Them | Zero |

"Cloud" is not a different codebase. It is: our servers + TLS + billing +
the app pointing at our URL instead of localhost. That is the whole
wrapper.

Self-hosting is a **side door for IT people**, not the Product Hunt path.
Nobody who saw us on Product Hunt should ever need Docker or a terminal.

## 3. THE OPEN FORK — does first launch require sign-in?

Two versions were on the table at the end of the discussion. They share
everything in §2. They differ in one thing.

**Version A — research default (what the mockup shows).**
The desktop app carries a small database *inside it*. First launch needs
no account and no server; the app just opens. Sign-in happens only at the
invite click, because that is the first moment anything needs a server.
Steps 1–5 of `onboarding-final.html` exist because of this.
- Pro: zero first-launch friction (the research put sign-up walls at 60–80%
  drop-off for this persona); the "nothing leaves your machine" pitch is
  literally true; zero hosting cost per free solo user.
- Cost: one engineering job — the **bundled local database** (§4, item 1).
  Today the packaged app bundles no database and assumes a docker-compose
  backend is already running; it does not open on its own.

**Version B — founder's sketch (2026-09-14).**
The desktop app is a window onto our cloud. All data — personal and team —
lives on our servers. Self-hosting means running that backend yourself.
- Pro: simpler to build; one data path; it is how Linear and Notion work.
- Cost: first launch **must** be a sign-in screen, because there is
  nowhere else to save anything. Deletes steps 1–5 of the mockup. Hosting
  cost per free solo user. The privacy pitch changes from "on your
  machine" to "in our cloud."

**CALLED 2026-09-14 (founder): Version A's packaging, plus a local
identity at first launch.**

- The app carries its own local database and opens with no server.
- First launch shows **one local profile screen** — a name and an email,
  **no password**, stored only in the local database. Its job is mapping:
  every ticket, session, and comment is attributed to a user id from day
  one. Nothing is sent anywhere; there is no account.
- At the invite click (or Sync), the one-time browser sign-in **links**
  that local profile to a verified identity rather than creating a second
  one. Existing local data already carries the user id, so nothing is
  re-attributed later.
- Cost accepted knowingly: this is Option B's soft-start screen, which the
  research rated as small-but-real friction. It stays one screen, no
  account, no password, so the "no sign-up wall" finding holds in
  substance. "Login" must never grow into credentials — a password on a
  local-only app protects nothing and creates a reset problem with no
  server to solve it.

**Schema consequence (AT7, ROAD-142):** Personal's member row *does* point
at a `users` row — a local, unverified one. `users.emailVerifiedAt` is
null until the browser sign-in links it. The earlier "Personal never gets
a users row" rule in the self-hosted auth doc §3 is superseded by this.

**Ticket consequence:** the bundled-local-database work (§4 item 1) and
this first-launch profile screen are one ticket — ROAD-149. AT10's
desktop sign-in client gains "link the local profile" as part of its
scope.

## 4. Build order

1. **Bundled local database** (Version A only) — the desktop app opens
   with zero setup. Not on the board yet; needs a ticket. Ships first
   regardless of anything else, because it is the Product Hunt download.
2. **Make the backend a team product** — sign-in, workspaces, members,
   invites (AT2, AT3, AT4). Built and tested against docker-compose on a
   laptop. When this is done, **the self-hosted version exists** — it is
   what we develop on every day, so its "available" claim is honest by
   construction.
3. **Cloud = bolt three things onto that same code** — deploy to our
   servers with TLS (AT1), billing (AT6), app defaults to our URL.
   Discovery UI (AT5) can land any time after step 2.

This **reorders the tech lead's plan**: AT1 (hosted deployment) was listed
first; it moves after AT2–AT4. You need docker-compose to build the
product, not our servers.

## 5. What this supersedes

- The idea that the Product Hunt release is "the cloud version" — no: the
  release is the desktop app; cloud is where a *team* lives by default.
- "Self-hosting available today" copy in the mockup (step 6): true for
  Personal only until step 2 above lands. See 004 §3.
