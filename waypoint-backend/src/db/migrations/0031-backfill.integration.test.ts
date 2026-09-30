import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

// `0031_notifications_foundation.sql` replaces the `read` boolean with
// `read_at`, and its hand-added UPDATE is the only thing carrying existing
// read state across before `read` is dropped. Same approach as the 0027
// test: execute the real file's statement verbatim against a scratch schema
// holding only the columns it touches, so it can't drift from what runs.
async function databaseReachable(): Promise<boolean> {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  const probe = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await probe`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 3 });
  }
}

const REAL_DB = await databaseReachable();

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/0031_notifications_foundation.sql',
);

function backfillStatement(): string {
  const statements = readFileSync(migrationPath, 'utf8').split('--> statement-breakpoint');
  const stripped = statements.map((s) =>
    s
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim(),
  );
  const update = stripped.find((s) => /^UPDATE\s+"notifications"/i.test(s));
  if (!update) throw new Error('0031 no longer has an UPDATE "notifications" statement — update this test.');
  return update;
}

describe.skipIf(!REAL_DB)('0031_notifications_foundation.sql backfill', () => {
  let db: typeof import('../client.js')['db'];
  const schemaName = `test_0031_backfill_${Date.now()}`;

  beforeAll(async () => {
    ({ db } = await import('../client.js'));
    await db.execute(sql.raw(`CREATE SCHEMA "${schemaName}"`));
    await db.execute(
      sql.raw(`
        CREATE TABLE "${schemaName}"."notifications" (
          "id" text PRIMARY KEY,
          "read" boolean NOT NULL,
          "read_at" timestamptz,
          "created_at" timestamptz NOT NULL,
          "updated_at" timestamptz NOT NULL DEFAULT now()
        )`),
    );
    await db.execute(
      sql.raw(`
        INSERT INTO "${schemaName}"."notifications" ("id", "read", "created_at") VALUES
          ('seen',   true,  '2026-09-01 10:00:00.123456+00'),
          ('unseen', false, '2026-09-02 11:00:00+00')`),
    );
    await db.execute(sql.raw(`SET search_path TO "${schemaName}", public`));
    await db.execute(sql.raw(backfillStatement()));
    await db.execute(sql.raw(`SET search_path TO public`));
  });

  afterAll(async () => {
    if (!db) return;
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`));
  });

  it('carries read state into read_at and sorts existing rows by when they were created', async () => {
    const rows = (await db.execute(
      sql.raw(
        // Compared as instants in SQL, so the server's display time zone can't
        // make a correct backfill look wrong.
        `SELECT "id", ("read_at" = "created_at") AS read_at_is_created, ("read_at" IS NULL) AS unread, ("updated_at" = "created_at") AS sorted FROM "${schemaName}"."notifications" ORDER BY "id"`,
      ),
    )) as unknown as { id: string; read_at_is_created: boolean | null; unread: boolean; sorted: boolean }[];
    expect(rows).toEqual([
      { id: 'seen', read_at_is_created: true, unread: false, sorted: true },
      { id: 'unseen', read_at_is_created: null, unread: true, sorted: true },
    ]);
  });
});
