import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../client.js';
import { sql } from 'drizzle-orm';

// Never-lock (2026-09-20): a regression test for
// `0027_never_lock_sessions_backfill.sql`'s backfill (found missing in
// review — the migration's own correctness had no test). Rather than
// hand-copy the UPDATE and risk it drifting from the file that actually
// runs, this reads the real migration file and executes its backfill
// statement verbatim — against a scratch schema holding only the columns
// that statement touches, so it needs no 27-migration chain.
//
// Round 2 (found in review): the backfill originally lived in 0026 itself,
// sharing that migration's transaction with `ALTER TABLE agent_runs ADD
// COLUMN` — which meant the backfill ran under the ACCESS EXCLUSIVE lock
// those ADD COLUMN statements took, no matter where DROP INDEX sat in the
// file (Postgres never releases a lock mid-transaction). Moved to its own
// migration/transaction so it starts with no exclusive lock on agent_runs
// at all.

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../drizzle/0027_never_lock_sessions_backfill.sql',
);

function backfillStatement(): string {
  const sqlText = readFileSync(migrationPath, 'utf8');
  const statements = sqlText.split('--> statement-breakpoint');
  const stripped = statements.map((s) =>
    s
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim(),
  );
  const update = stripped.find((s) => /^UPDATE\s+"agent_runs"/i.test(s));
  if (!update) throw new Error('0027 no longer has an UPDATE "agent_runs" statement — update this test.');
  return update;
}

describe('0027_never_lock_sessions_backfill.sql backfill', () => {
  const schemaName = `test_0027_backfill_${Date.now()}`;

  beforeAll(async () => {
    await db.execute(sql.raw(`CREATE SCHEMA "${schemaName}"`));
    // Only the columns the backfill statement itself reads or writes —
    // a real drift-proof test of that one statement, not a rebuild of
    // agent_runs's full shape.
    await db.execute(
      sql.raw(`
        CREATE TABLE "${schemaName}"."agent_runs" (
          "id" text PRIMARY KEY,
          "entry" text NOT NULL,
          "status" text NOT NULL,
          "finalize_count" integer NOT NULL DEFAULT 0
        )
      `),
    );
    await db.execute(
      sql.raw(`
        INSERT INTO "${schemaName}"."agent_runs" (id, entry, status) VALUES
          ('dispatched-done', 'dispatched', 'done'),
          ('dispatched-needs-review', 'dispatched', 'needs-review'),
          ('dispatched-running', 'dispatched', 'running'),
          ('dispatched-failed', 'dispatched', 'failed'),
          ('independent-done', 'independent', 'done')
      `),
    );
    await db.execute(sql.raw(`SET search_path TO "${schemaName}", public`));
    await db.execute(sql.raw(backfillStatement()));
    await db.execute(sql.raw('SET search_path TO public'));
  });

  afterAll(async () => {
    await db.execute(sql.raw(`DROP SCHEMA "${schemaName}" CASCADE`));
  });

  it('sets finalize_count=1 on dispatched done/needs-review rows only', async () => {
    const rows = await db.execute<{ id: string; finalize_count: number }>(
      sql.raw(`SELECT id, finalize_count FROM "${schemaName}"."agent_runs" ORDER BY id`),
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.finalize_count]));
    expect(byId).toEqual({
      'dispatched-done': 1,
      'dispatched-failed': 0,
      'dispatched-needs-review': 1,
      'dispatched-running': 0,
      'independent-done': 0,
    });
  });
});
