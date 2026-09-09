import 'dotenv/config';
import { createApp } from './app.js';
import { repairProposals } from './services/proposals.service.js';

// 14000, not Express's conventional 4000 — see docker-compose.yml's PORT
// comment for why (avoids a local-machine port conflict with another
// project). Only the fallback moved; PORT itself still wins when set.
const port = Number(process.env.PORT ?? 14000);
const host = process.env.HOST || '127.0.0.1';
const app = createApp();

// 127.0.0.1 by default, not the default all-interfaces bind — this process
// has no auth (see app.ts's CORS comment), so binding 0.0.0.0 in the
// documented `npm run dev` flow (Postgres in Docker, API on the host) would
// put every GET /proposals read and every POST
// /copilot/proposals/:id/approve write on the LAN for any non-browser
// client, which sends no Origin header and so isn't stopped by CORS at all.
//
// HOST lets the containerized path opt back in to 0.0.0.0: a process bound
// to loopback *inside* a container is unreachable through Docker's own
// network namespace, including docker-compose.yml's 127.0.0.1 publish rule
// (that rule forwards to the container's internal network, not to
// 127.0.0.1 inside it). docker-compose.yml sets HOST=0.0.0.0 for the api
// service for exactly this reason, and stays closed to the LAN via that
// same publish rule — see its comment there.
app.listen(port, host, () => {
  console.log(`waypoint-server listening on http://localhost:${port}`);
});

// The proposals repair pass's primary schedule (W3.3 — architecture §4.2).
// listProposals still runs it lazily too (guarded to at most once a
// minute), but this interval is what keeps a quiet workspace's expired/
// stuck rows current even when nobody happens to load a list in between.
// unref() so this timer alone never keeps the process alive past a normal
// shutdown.
setInterval(() => {
  repairProposals().catch((error) => {
    console.error('[proposals] repair pass failed:', error);
  });
}, 60 * 1000).unref();
