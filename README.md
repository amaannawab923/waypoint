# Waypoint

**The world's first project management tool that actually ships as a native
desktop app.** Not a web page in a browser tab pretending to be an app —
Waypoint is a real Electron application: projects, cycles, modules, work
items, pages, intake, and AI agent assignments, all running natively on your
machine and talking to a real backend, not local-storage.

![Waypoint — work item detail](./docs/screenshots/work-item-detail.png)

This repo holds the entire product — frontend and backend — in one place.

| Folder | What it is |
|---|---|
| [`waypoint-frontend`](./waypoint-frontend) | The Electron + React desktop client users actually run |
| [`waypoint-backend`](./waypoint-backend) | The Express + Postgres API that backs it |

## What's in the box

- **Work item tracking** — boards, lists, a calendar view, a Gantt view, and a
  spreadsheet view over the same underlying data, with states, priorities,
  estimates, labels, assignees, sub-items, and full activity history.
- **Cycles & modules** — sprint-style cycles with burndown charts, and modules
  for grouping work items outside the cycle timeline.
- **Pages & saved views** — freeform docs per project, and shareable filtered
  views of your work items.
- **Intake** — a triage queue for incoming requests before they become real
  work items.
- **AI agents** — assign an agent to a work item, hand work back and forth,
  and track agent-driven activity alongside human activity in the same log.
- **Real, address-bar-updating routes** — deep links, hard-refresh, and
  browser back/forward all work correctly, in the dev server, in the packaged
  desktop app, and (by construction) if this ever ships as a plain website too.

## Screenshots

**Home** — a daily-driver landing page, not a dashboard nobody opens twice.

![Home](./docs/screenshots/home.png)

**Work items** — states, priorities, labels, assignees, and sub-item
progress at a glance.

![Work items](./docs/screenshots/work-items.png)

**Cycles** — sprint-style iterations with a live burndown chart.

![Cycles](./docs/screenshots/cycles.png)

## Getting started

You need both halves running — the frontend has no offline/mock mode, it
always talks to a real backend.

```bash
# 1. Backend
cd waypoint-backend
cp .env.example .env
docker compose up -d
npm install
npm run db:generate && npm run db:migrate && npm run db:seed
npm run dev              # http://localhost:4000

# 2. Frontend, in a second terminal
cd waypoint-frontend
npm install
npm start                 # opens the Electron app, hot-reloading
```

See each folder's own README for the full script list, project layout, and
how to build a packaged installer.

## Stack

**Frontend:** Electron, React 19, React Router, TypeScript, Tailwind CSS,
webpack (via `electron-react-boilerplate`'s toolchain).

**Backend:** Express, Drizzle ORM, Postgres, Zod, TypeScript.

## License

MIT — see [`LICENSE`](./LICENSE).
