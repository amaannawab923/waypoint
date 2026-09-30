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
 *   - it is read-only by default (it writes nothing, not even the ledger
 *     table) and prints exactly what it would stamp;
 *   - `--apply --through <tag>` is required to write anything, and stamps
 *     only entries up to and including that tag. A newer migration the
 *     database has never run is never stamped by mistake;
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

/** The value after `--through`, if given. */
function throughTag(argv: string[]): string | null {
  const i = argv.indexOf('--through');
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const through = throughTag(process.argv);
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const journal = JSON.parse(
    readFileSync(path.join(drizzleDir, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };

  // --apply must name the LAST migration whose objects are known to exist.
  // Stamping "everything missing" would also stamp a genuinely new
  // migration the database has never run, and drizzle-kit would then skip
  // it forever, which is exactly the silent-drift problem this command
  // exists to fix. Naming the boundary makes that impossible by accident.
  let boundary = journal.entries.length - 1;
  if (through !== null) {
    boundary = journal.entries.findIndex((e) => e.tag === through);
    if (boundary < 0) {
      console.error(`--through ${through}: no such entry in the journal.`);
      process.exit(1);
    }
  } else if (apply) {
    console.error(
      '--apply needs --through <tag>: the last migration you have confirmed is already\n' +
        "reflected in the schema. See this file's header for how to confirm it.",
    );
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // Read-only by default, genuinely: the ledger table is only created on
    // --apply. A dry run used to issue CREATE SCHEMA / CREATE TABLE IF NOT
    // EXISTS, which is a write, however harmless it looked.
    const [{ exists }] = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`;
    const rows = exists
      ? await sql<{ hash: string }[]>`SELECT hash FROM drizzle.__drizzle_migrations`
      : [];
    const recorded = new Set(rows.map((r) => r.hash));

    const inScope = journal.entries.slice(0, boundary + 1);
    const missing = inScope
      .map((e) => ({ ...e, hash: migrationHash(e.tag) }))
      .filter((e) => !recorded.has(e.hash));

    const scopeNote =
      through !== null ? ` up to and including ${through}` : '';
    if (missing.length === 0) {
      console.log(`Ledger is complete${scopeNote}: nothing to record.`);
      return;
    }

    console.log(
      `${recorded.size} of ${journal.entries.length} journal entries are recorded. Missing${scopeNote}:\n`,
    );
    missing.forEach((e) => console.log(`  ${String(e.idx).padStart(4)}  ${e.tag}`));

    if (!apply) {
      console.log(
        '\nRead-only; nothing was written. To record these as applied, re-run with\n' +
          '--apply --through <tag>, but ONLY after confirming the schema already\n' +
          "matches up to that tag. See this file's header for how.",
      );
      return;
    }

    // One transaction: a partial stamp is a worse ledger than no stamp.
    await sql.begin(async (tx) => {
      await tx`CREATE SCHEMA IF NOT EXISTS drizzle`;
      await tx`
        CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )`;
      for (const e of missing) {
        // eslint-disable-next-line no-await-in-loop
        await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${e.hash}, ${e.when})`;
      }
    });
    console.log(
      `\nRecorded ${missing.length} entries${scopeNote}. Anything after it will still be applied by \`npm run db:migrate\`.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
