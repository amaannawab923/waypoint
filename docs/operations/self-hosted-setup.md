# Self-hosted Team setup

Spec: `docs/design/self-hosted-auth-and-multitenancy.md` §8. This is the
operator-facing walkthrough that spec section promised — everything a
self-hoster configures to bring up a real, multi-person Team workspace on
their own infrastructure, with no account, API key, or license check from
us anywhere in the path.

If you only want Personal (a single person, no sign-in, no server) — you
don't need any of this. It's for a team that wants to sign in, invite each
other, and share workspaces against a backend they run themselves.

## Prerequisites

- Docker and Docker Compose.
- `waypoint-backend/.env`, copied from `.env.example` in the same
  directory (`cp .env.example .env`) — `docker compose up` reads it
  automatically for everything from "Accounts" onward in that file (see
  `docker-compose.yml`'s own comments for exactly which variables that
  covers; `DATABASE_URL`/`PORT`/`HOST` are hardcoded in the compose file
  itself and unaffected by this `.env`).

## Step 1 — pick an instance setup token

Generate any random string and set it as `INSTANCE_SETUP_TOKEN` in your
`.env`:

```bash
openssl rand -hex 32
```

Whoever holds this value can complete first-run setup and become this
instance's admin — the same trust level as whoever holds `DATABASE_URL`.
Keep it out of source control the same way.

## Step 2 — configure at least one sign-in method

Every method below is independently optional, and you can set more than
one — but **at least one full method is required**, or first-run setup
refuses to complete (see "What happens if nothing is configured," below).
None of these require an account with us; every registration is
self-service, against your own GitHub/Google/SMTP account, and takes a few
minutes.

### GitHub OAuth App

1. GitHub → Settings → Developer settings → **OAuth Apps** → **New OAuth
   App** (or, for an organization-owned app, your org's own Developer
   settings).
2. **Homepage URL**: anything reasonable — your instance's public URL if
   it has one, or your org's site.
3. **Authorization callback URL**: `<PUBLIC_BASE_URL>/auth/github/callback`
   — literally that path, where `<PUBLIC_BASE_URL>` is the same value
   you'll set for the `PUBLIC_BASE_URL` env var below (for local-only use,
   that's `http://localhost:14000/auth/github/callback`).
4. Register the app, then generate a **Client secret**.
5. Set `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` in your
   `.env` from the values GitHub just gave you.

### Google Cloud OAuth client

1. [Google Cloud Console](https://console.cloud.google.com/) → create (or
   pick) a project → **APIs & Services → Credentials**.
2. **Create Credentials → OAuth client ID**, application type **Web
   application**.
3. Under **Authorized redirect URIs**, add
   `<PUBLIC_BASE_URL>/auth/google/callback` — same path convention as
   GitHub above.
4. If prompted to configure the OAuth consent screen first, **External**
   is fine for this use (no Google verification review is required for a
   small number of users signing into your own instance — Google will show
   an "unverified app" warning to sign-ins beyond a low cap until you
   verify, which is a Google policy, not something this app can change).
5. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in your
   `.env` from the client ID/secret Google just gave you.

### Email (magic link) via any SMTP relay

No specific provider is required — any SMTP relay you can already send
mail through works (a transactional-email provider, your own mail server,
even a personal account's SMTP if its provider allows app-level access).
Set in `.env`:

- `SMTP_HOST`, `SMTP_FROM` — the two required values.
- `SMTP_PORT` (default assumption: 465 is implicit TLS, anything else
  starts plain and upgrades with STARTTLS), `SMTP_USER`, `SMTP_PASS` — as
  your relay requires.

## Step 3 — set `PUBLIC_BASE_URL`

The URL this backend is actually reachable at from a browser — what you
registered as the callback host above. For local-only use, leave it unset
(it defaults to `http://localhost:<PORT>`). For anything reachable beyond
your own machine, set it to the real, public URL — see "Reaching this
instance beyond localhost," below, before you do.

This is also whatever address you point the desktop app's own
`WAYPOINT_API_BASE_URL` at — an environment variable set before
launching the app, not a setting in the app itself; there is no
in-app field for it yet. Both need to name the *same* backend for
sign-in to complete. For plain loopback use, `localhost` and `127.0.0.1`
(and `[::1]`, if you've bound this backend to it) are all
interchangeable here (this backend trusts all of them for its own
origin); once you set a real `PUBLIC_BASE_URL`, use that exact value on
the desktop side too.

## Step 4 — bring the stack up

```bash
cd waypoint-backend
docker compose up -d
```

This starts Postgres and the API, runs migrations, and publishes the API
on `127.0.0.1:14000` (see "Reaching this instance beyond localhost" for
what that loopback binding means and doesn't mean).

## Step 5 — complete first-run setup

There is no setup wizard screen yet — this is a one-time API call you make
yourself, with the setup token from Step 1 as a bearer token:

```bash
curl -X POST http://localhost:14000/instance/setup \
  -H "Authorization: Bearer <your INSTANCE_SETUP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "instanceName": "Acme",
    "signupMode": "invite_only",
    "admin": { "email": "you@acme.com", "fullName": "Your Name" }
  }'
```

`signupMode` is `"open"` (anyone who can sign in with a configured method
can create their own workspace) or `"invite_only"` (workspaces are only
joined via an invite link — see `docs/design/self-hosted-auth-and-multitenancy.md`
§7). This is **not** an environment variable — it's set here, once, and
can be changed afterward by a signed-in instance admin via
`PATCH /admin/instance`. (An earlier draft of the design spec described an
`INSTANCE_SIGNUP_MODE` env var as an alternative way to set this; that
mechanism was never built, and this API call is the one real way to set
or change it — this doc describes what the backend actually does, not
what an earlier draft proposed.)

Your own account (the `admin.email` above) is created unverified — signing
in for the first time with that same email, via whichever method(s) you
configured, links and verifies it. Until then it's a claim the setup-token
holder made, which is exactly what holding the token means.

## What happens if nothing is configured

This is the honest failure mode, not a bug: with no `INSTANCE_SETUP_TOKEN`
set, `POST /instance/setup` answers `503` — first-run setup is not gated
open by accident. With a token set but no sign-in method configured (no
GitHub/Google pair, no `SMTP_HOST`+`SMTP_FROM`), the same endpoint refuses
with a clear `400` explaining that at least one is required — this backend
will not produce an instance nobody could actually sign into. There is no
built-in fallback account, demo mode, or bypass; configure at least one
real sign-in method before setup can complete.

## Reaching this instance beyond localhost

`docker-compose.yml` publishes the API as `127.0.0.1:14000:14000` —
loopback only, unchanged by this epic. That means, out of the box, this
instance is reachable from the machine running Docker and nowhere else,
even on the same LAN.

Putting a real team on this instance — anyone not sitting at that exact
machine — requires your own reverse proxy (nginx, Caddy, Traefik, your
cloud provider's load balancer, etc.) terminating TLS and forwarding to
this container, plus a real DNS name pointed at it. That is deliberately
**not** something this compose file or this ticket builds: it's your own
infrastructure decision (self-hosted, your network, your certificate
authority of choice), the same way DATABASE_URL's credentials are yours to
rotate. Once you have one, set `PUBLIC_BASE_URL` to that real URL and
re-register the GitHub/Google OAuth callback URLs to match it — the
callback URLs above have to be the URL your team's browsers actually see,
not `localhost`.

## Persisting state across restarts

Two named volumes in `docker-compose.yml` hold everything that needs to
survive a container rebuild: `waypoint_pgdata` (Postgres — projects,
tickets, users, everything) and `waypoint_secrets` (the encryption key for
a hosted Team member's own stored Jira credential, AT12). Losing
`waypoint_secrets` specifically is survivable but real: every Team
member's stored Jira connection would report itself as needing to be
reconnected. Back up both volumes the way you'd back up any other stateful
service you run yourself — this app doesn't do it for you.
