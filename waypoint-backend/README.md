# Waypoint — Backend (API server)

The REST API that backs the [`waypoint-frontend`](../waypoint-frontend) Electron
app: projects, work items, cycles, modules, pages, saved views, intake, agents,
and everything else the desktop client renders.

See the [root README](../README.md) for the product pitch and how this fits
together with the frontend.

## Stack

- Express + TypeScript
- Drizzle ORM over Postgres
- Zod for request validation
- Postgres runs locally via Docker Compose in dev

## Getting started

For most workflows, `../scripts/dev.sh` from the repo root is simpler — it
builds and runs this whole service (Postgres + API) in Docker, including
migrations and demo-data seeding, with no manual steps below required.

Run the API natively instead (e.g. to use a debugger, or iterate faster
than a container rebuild) with:

```bash
cp .env.example .env          # DATABASE_URL, PORT (defaults to 4000)
docker compose up -d postgres # starts only Postgres — the api service in
                               # this same compose file runs the API in a
                               # container, which would conflict with the
                               # `npm run dev` below on the same port
npm install
npm run db:generate           # generate migrations from the schema
npm run db:migrate            # apply them
npm run db:seed               # seed demo data — destructive: truncates
                               # every table first, so only run this
                               # against a database you're fine resetting
npm run dev                   # starts the API on PORT (default 4000)
```

`waypoint-frontend` expects this running on `http://localhost:4000` by default
(`WAYPOINT_API_BASE_URL` on the frontend side if you need to point it elsewhere).

CORS is restricted to a known set of origins (see `src/app.ts`) — by
default the webpack dev server and the packaged app's `app://waypoint`
scheme, which covers the frontend's two normal run modes with nothing to
configure. Set `CORS_ORIGIN` (comma-separated) in `.env` only if you're
running the frontend from somewhere else.

## Useful scripts

```bash
npm run db:studio    # Drizzle Studio — browse/edit the database directly
npm run build         # compile to dist/
npm run start          # run the compiled build
```

A `POST /dev/reset` endpoint (disabled when `NODE_ENV=production`) truncates
every table and reruns the seed script — handy for getting back to a known
clean state during development.

## Project layout

```
src/
  index.ts        Entrypoint — starts the HTTP server
  app.ts           Express app assembly: CORS, body parsing, route mounting
  db/
    client.ts       Drizzle/Postgres client
    schema/          One file per resource group (projects, work-items, …)
    seed.ts          Demo data used by npm run db:seed and POST /dev/reset
  lib/              Small shared helpers (id generation, …)
  middleware/        Request validation wiring, centralized error handling
  validation/         Zod schemas per resource
  services/           Business logic — one file per resource group
  routes/              Express routers — thin handlers that delegate to services
```
