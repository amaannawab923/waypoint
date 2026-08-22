// Run by docker-entrypoint.sh on every container start. `seed()` itself is
// destructive (truncates every table first — see seed.ts), which is exactly
// right for the manual `npm run db:seed` reset command but would wipe real
// data on every container restart if called unconditionally here. Guard it
// behind an emptiness check so a fresh database gets demo data automatically
// and an existing one is left alone.
import { db } from './client.js';
import { workspaces } from './schema/workspace.js';
import { seed } from './seed.js';

async function main() {
  const existing = await db.select({ id: workspaces.id }).from(workspaces).limit(1);
  if (existing.length > 0) {
    console.log('Workspace data already present — skipping seed.');
    return;
  }
  console.log('No workspace data found — seeding demo data...');
  await seed();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed check failed:', err);
    process.exit(1);
  });
