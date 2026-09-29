/**
 * `npm run db:baseline` — records journal entries as applied WITHOUT running
 * their SQL.
 *
 * Why this exists. This project's dev database was brought forward with
 * `drizzle-kit push` at some point, which changes the schema but writes
 * nothing to `drizzle.__drizzle_migrations`. The result is a database whose
 * schema is fully up to date while its ledger says only the first N
 * migrations ever ran — and `drizzle-kit migrate` then tries to replay
 * migrations whose objects already exist and fails on the first one. That
 * state is invisible until someone adds a migration and discovers they
 * cannot apply it.
 *
 * What this does NOT do: it never executes migration SQL and never alters a
 * table. It only inserts ledger rows, using the same hash drizzle itself
 * computes (sha256 of the migration file's raw bytes) and the `when` from
 * the journal, so a subsequent `drizzle-kit migrate` agrees the entry is
 * already applied and moves on to the genuinely new ones.
 *
 * SAFETY. Stamping a migration whose SQL never actually ran leaves a
 * database that silently lacks those objects, with a ledger claiming
 * otherwise — strictly worse than the problem this fixes. So:
 *
 *   - it is read-only by default and prints exactly what it would stamp;
 *   - `--apply` is required to write anything;
 *   - before using `--apply`, confirm the schema really does match what the
 *     migrations produce. The reliable way is to migrate a scratch database
 *     from empty and diff the two:
 *
 *       createdb waypoint_migcheck
 *       DATABASE_URL=postgres://…/waypoint_migcheck npx drizzle-kit migrate
 *       psql "$DATABASE_URL" -tAc "select table_name||'.'||column_name||':'||data_type||':'||is_nullable \
 *         from information_schema.columns where table_schema='public' order by 1;" > /tmp/a.txt
 *       # …same against the scratch database, then diff. An empty diff is
 *       # the evidence that stamping is safe.
 *
 * A fresh database needs none of this — `drizzle-kit migrate` handles it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(here, '../../drizzle');

function migrationHash(tag: string): string {
  // Raw bytes, matching drizzle-orm's own migrator — verified against the
  // rows this database already had before this script existed.
  return createHash('sha256').update(readFileSync(path.join(drizzleDir, `${tag}.sql`))).digest('hex');
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const journal = JSON.parse(
    readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };

  // onnotice silenced: the CREATE ... IF NOT EXISTS below raises a
  // "relation already exists, skipping" NOTICE on every normal run, which
  // postgres.js prints as a multi-line object that reads exactly like a
  // failure. The notice is the expected case here, not news.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await sql`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )`;

    const rows = await sql<{ hash: string }[]>`SELECT hash FROM drizzle.__drizzle_migrations`;
    const recorded = new Set(rows.map((r) => r.hash));

    const missing = journal.entries
      .map((e) => ({ ...e, hash: migrationHash(e.tag) }))
      .filter((e) => !recorded.has(e.hash));

    if (missing.length === 0) {
      console.log(`Ledger is complete: all ${journal.entries.length} journal entries are recorded.`);
      return;
    }

    console.log(
      `${recorded.size} of ${journal.entries.length} journal entries are recorded. Missing:\n`,
    );
    missing.forEach((e) => console.log(`  ${String(e.idx).padStart(4)}  ${e.tag}`));

    if (!apply) {
      console.log(
        '\nRead-only. Re-run with --apply to record these as applied, but ONLY after\n' +
          "confirming the schema already matches — see this file's header for how.",
      );
      return;
    }

    // One transaction: a partial stamp is a worse ledger than no stamp.
    await sql.begin(async (tx) => {
      for (const e of missing) {
        // eslint-disable-next-line no-await-in-loop
        await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${e.hash}, ${e.when})`;
      }
    });
    console.log(`\nRecorded ${missing.length} entries. \`npm run db:migrate\` should now be a no-op.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
