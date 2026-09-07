import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

// ticketRefs.service.ts's own upsert relies on real Postgres semantics this
// file's mocked-Drizzle siblings (jira.test.ts, mcp.routes.test.ts — both
// vi.mock() this module wholesale) cannot exercise: an ON CONFLICT target
// tied to a real unique constraint, `excluded.*` referencing the row that
// conflict produced, and Postgres's own "cannot affect row a second time"
// rule that rememberMany's own de-duplication step exists specifically to
// avoid. A mock can only assert what arguments this file PASSES to Drizzle;
// only real Postgres can prove the upsert actually behaves as one. Same
// rationale, and same skip-when-unreachable shape, as
// proposals.service.integration.test.ts.
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

describe.skipIf(!REAL_DB)('ticketRefs against real Postgres', () => {
  let service: typeof import('./ticketRefs.service.js');
  let db: typeof import('../db/client.js')['db'];
  let schema: typeof import('../db/schema/index.js');
  let eq: typeof import('drizzle-orm')['eq'];
  let and: typeof import('drizzle-orm')['and'];

  // A site value unique to this run (not a real Jira hostname) plus
  // Date.now()-suffixed external ids: afterAll's own targeted delete relies
  // on `site` alone to scope cleanup, since every row this file inserts
  // shares it and no real seed data ever will.
  const site = `itest-${Date.now()}.invalid`;

  beforeAll(async () => {
    // Dynamic, not top-level: db/client.ts throws on import when
    // DATABASE_URL is unset, which would fail this file instead of skipping it.
    ({ db } = await import('../db/client.js'));
    service = await import('./ticketRefs.service.js');
    schema = await import('../db/schema/index.js');
    ({ eq, and } = await import('drizzle-orm'));
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.ticketRefs).where(eq(schema.ticketRefs.externalSite, site));
  });

  it('mints a new handle on first sight, and the SAME handle on every later sighting', async () => {
    const first = await service.remember({
      provider: 'jira',
      site,
      externalId: 'ENG-1',
      identifier: 'ENG-1',
      title: 'Checkout 500s',
      url: `https://${site}/browse/ENG-1`,
    });
    expect(first.id).toMatch(/^tref-/);
    expect(first.externalId).toBe('ENG-1');
    expect(first.cachedTitle).toBe('Checkout 500s');

    // Seeing the SAME (provider, site, externalId) again must refresh the
    // cached fields but mint no second handle — this is the module's whole
    // reason to exist, stated in its own header comment.
    const second = await service.remember({
      provider: 'jira',
      site,
      externalId: 'ENG-1',
      identifier: 'ENG-1',
      title: 'Checkout 500s — now P1',
      url: `https://${site}/browse/ENG-1`,
    });
    expect(second.id).toBe(first.id);
    expect(second.cachedTitle).toBe('Checkout 500s — now P1');

    // Read back through a fresh query — the assertion is about what
    // Postgres actually stored, not about the upsert's own RETURNING value.
    const persisted = await service.findById(first.id);
    expect(persisted?.id).toBe(first.id);
    expect(persisted?.cachedTitle).toBe('Checkout 500s — now P1');
  });

  it('a moved issue (identifier changed, externalId unchanged) keeps its handle and updates the identifier', async () => {
    // ticketRefs.ts's own column comment: a Jira issue key can be reassigned
    // when an issue moves between projects. externalId is what identifies
    // the SAME issue across that move; cachedIdentifier is just the display
    // form and must follow along, not fork into a second row.
    const before = await service.remember({
      provider: 'jira',
      site,
      externalId: '10042',
      identifier: 'ENG-2',
      title: 'Flaky test',
      url: `https://${site}/browse/ENG-2`,
    });

    const after = await service.remember({
      provider: 'jira',
      site,
      externalId: '10042',
      identifier: 'OPS-9',
      title: 'Flaky test',
      url: `https://${site}/browse/OPS-9`,
    });

    expect(after.id).toBe(before.id);
    expect(after.cachedIdentifier).toBe('OPS-9');

    const byOldIdentifier = await service.findByIdentifier('jira', site, 'ENG-2');
    expect(byOldIdentifier).toBeUndefined();
    const byNewIdentifier = await service.findByIdentifier('jira', site, 'OPS-9');
    expect(byNewIdentifier?.id).toBe(before.id);
  });

  it('de-duplicates a batch containing the same (provider, site, externalId) twice, without erroring', async () => {
    // What this test actually proves, precisely: rememberMany's own
    // in-memory Map-based de-duplication runs BEFORE the batch ever reaches
    // Postgres, so this never gives Postgres a real (provider, site,
    // externalId) conflict within one command to reject — this test alone
    // does not exercise Postgres's own "cannot affect row a second time"
    // rule (found in review: an earlier version of this comment claimed
    // that it did). What it DOES prove, and needs real Postgres for: that
    // the de-duplication step this file's own header comment describes is
    // actually wired in and actually prevents the whole batch from failing
    // — a mocked db.insert could return success unconditionally regardless
    // of whether de-duplication ran at all. Without the real step, a Jira
    // search page containing the same issue twice (a real thing that
    // happens) would fail the whole search.
    const rows = await service.rememberMany([
      { provider: 'jira', site, externalId: 'ENG-3', identifier: 'ENG-3', title: 'First sighting', url: null },
      { provider: 'jira', site, externalId: 'ENG-3', identifier: 'ENG-3', title: 'Second sighting, same page', url: null },
    ]);

    expect(rows.size).toBe(1);
    // Last-write-wins within the de-duplication Map, matching its own
    // documented behavior (a plain Map.set per entry, in array order).
    expect(rows.get('ENG-3')?.cachedTitle).toBe('Second sighting, same page');
  });

  it('rememberMany batches distinct rows into one upsert and returns each keyed by its own externalId', async () => {
    const rows = await service.rememberMany([
      { provider: 'jira', site, externalId: 'ENG-4', identifier: 'ENG-4', title: 'A', url: null },
      { provider: 'jira', site, externalId: 'ENG-5', identifier: 'ENG-5', title: 'B', url: null },
      { provider: 'jira', site, externalId: 'ENG-6', identifier: 'ENG-6', title: 'C', url: null },
    ]);

    expect(rows.size).toBe(3);
    // Matched by externalId, not by array/RETURNING order — an upsert's
    // RETURNING order is not promised to match the VALUES order, which is
    // exactly why rememberMany keys its return Map this way instead.
    expect(rows.get('ENG-4')?.cachedTitle).toBe('A');
    expect(rows.get('ENG-5')?.cachedTitle).toBe('B');
    expect(rows.get('ENG-6')?.cachedTitle).toBe('C');
  });

  it('findByIdentifier scopes to the given provider and site, not identifier alone', async () => {
    await service.remember({
      provider: 'jira',
      site,
      externalId: 'ENG-7',
      identifier: 'DUP-1',
      title: 'On this site',
      url: null,
    });
    const otherSite = `${site}-other`;
    await service.remember({
      provider: 'jira',
      site: otherSite,
      externalId: 'ENG-7',
      identifier: 'DUP-1',
      title: 'Same identifier, different site',
      url: null,
    });

    const found = await service.findByIdentifier('jira', site, 'DUP-1');
    expect(found?.cachedTitle).toBe('On this site');

    // Clean up the second site's row too — outside this file's normal
    // afterAll scope (which filters on `site` alone).
    await db.delete(schema.ticketRefs).where(and(eq(schema.ticketRefs.externalSite, otherSite)));
  });

  it('findById returns undefined for an id nothing minted', async () => {
    expect(await service.findById('tref-doesnotexist')).toBeUndefined();
  });
});
