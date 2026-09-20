import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Never-lock, round 2 (found in review): the original 0026 file put a
// comment on DROP INDEX claiming it ran "with the ACCESS EXCLUSIVE window
// shrunk to the DROP INDEX statement itself" because it sat after the
// backfill UPDATE in file order. That claim was false — drizzle-kit's
// `migrate()` wraps a whole file in one transaction, and Postgres holds a
// lock until COMMIT regardless of statement order, so the ACCESS EXCLUSIVE
// taken by 0026's own `ALTER TABLE agent_runs ADD COLUMN` statements spanned
// the backfill's full-table scan the whole time. The only real fix is a
// second transaction: this test pins that split at the file level, so a
// future "helpful" merge of 0027 back into 0026 fails loudly here instead
// of silently reintroducing the exact bug this round found.

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');
const stripComments = (s: string) =>
  s
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim();
const statementsOf = (file: string) =>
  readFileSync(resolve(dir, file), 'utf8')
    .split('--> statement-breakpoint')
    .map(stripComments)
    .filter(Boolean);

describe('0026 / 0027 lock-window split', () => {
  it('0026 has no UPDATE or DROP INDEX — only fast, catalog-only DDL', () => {
    const statements = statementsOf('0026_never_lock_sessions.sql');
    expect(statements.some((s) => /^UPDATE\b/i.test(s))).toBe(false);
    expect(statements.some((s) => /^DROP INDEX\b/i.test(s))).toBe(false);
  });

  it('0027 runs the backfill UPDATE before DROP INDEX, and nothing else', () => {
    const statements = statementsOf('0027_never_lock_sessions_backfill.sql');
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^UPDATE\s+"agent_runs"/i);
    expect(statements[1]).toMatch(/^DROP INDEX\s+"agent_runs_one_live_writer_per_ticket"/i);
  });
});
