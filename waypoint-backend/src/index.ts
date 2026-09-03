import 'dotenv/config';
import { createApp } from './app.js';
import { repairProposals } from './services/proposals.service.js';

// 14000, not Express's conventional 4000 — see docker-compose.yml's PORT
// comment for why (avoids a local-machine port conflict with another
// project). Only the fallback moved; PORT itself still wins when set.
const port = Number(process.env.PORT ?? 14000);
const app = createApp();

app.listen(port, () => {
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
