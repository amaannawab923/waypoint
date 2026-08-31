import 'dotenv/config';
import { createApp } from './app.js';

// 14000, not Express's conventional 4000 — see docker-compose.yml's PORT
// comment for why (avoids a local-machine port conflict with another
// project). Only the fallback moved; PORT itself still wins when set.
const port = Number(process.env.PORT ?? 14000);
const app = createApp();

app.listen(port, () => {
  console.log(`waypoint-server listening on http://localhost:${port}`);
});
