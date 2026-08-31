import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { errorHandler } from '../middleware/errorHandler.js';

// This is the one integration point proving the Express-mounted MCP
// transport actually speaks the protocol correctly end-to-end — a real
// @modelcontextprotocol/sdk Client (the same client machinery the spawned
// `claude` CLI itself uses) drives the initialize handshake and tool call
// over a real HTTP connection, rather than hand-authoring raw JSON-RPC
// bodies that could get the handshake details wrong. workItemTools.test.ts
// covers the tool handlers' own logic against mocked services; this test
// only needs one tool exercised to prove the wiring works.
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/workItems.service.js');
vi.mock('../services/states.service.js');
const workItemsService = await import('../services/workItems.service.js');
const { resolveStateNames } = await import('../services/states.service.js');
const { mcpRouter } = await import('./mcp.routes.js');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(mcpRouter);
  app.use(errorHandler);
  return app;
}

let httpServer: Server;
let baseUrl: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(resolveStateNames).mockResolvedValue(new Map());
  const app = buildTestApp();
  await new Promise<void>((resolve) => {
    httpServer = app.listen(0, resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('expected a network address');
  baseUrl = `http://127.0.0.1:${address.port}/mcp/copilot`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('POST /mcp/copilot', () => {
  it('serves a real MCP client end-to-end: initialize, then a tool call reaches the service layer', async () => {
    vi.mocked(workItemsService.listAllWorkItems).mockResolvedValue([
      { id: 'wi-1', identifier: 'WI-1', title: 'Fix login bug', projectId: 'proj-1', stateId: 'state-1', priority: 'high', assigneeIds: [] } as never,
    ]);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({ name: 'list_work_items', arguments: {} });

    expect(workItemsService.listAllWorkItems).toHaveBeenCalled();
    const content = (result.content as { type: string; text: string }[])[0];
    expect(JSON.parse(content.text)).toEqual({
      items: [
        {
          id: 'wi-1',
          identifier: 'WI-1',
          title: 'Fix login bug',
          projectId: 'proj-1',
          stateId: 'state-1',
          stateName: 'state-1',
          priority: 'high',
          assigneeIds: [],
          assigneeNames: [],
        },
      ],
      truncated: false,
    });

    await client.close();
  });

  it('reports a real service error back to the MCP client as a tool error, not a dropped connection', async () => {
    vi.mocked(workItemsService.getWorkItem).mockResolvedValue(undefined);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({ name: 'get_work_item', arguments: { id: 'missing' } });

    expect(result.isError).toBe(true);
    await client.close();
  });

  // Regression test: dueBefore's inputSchema previously accepted any
  // string, so a malformed value reached workItems.service.ts's
  // lte(workItems.dueDate, ...) raw and could leak a Postgres error string
  // back into the chat. It's now a regex-validated ISO date, so the real
  // MCP protocol layer (zod's own tool-input validation, not this app's
  // handler code) must reject a bad value before the service is ever
  // called — surfaced to the client as a tool error result, not a dropped
  // connection or thrown exception.
  it('rejects a malformed dueBefore at the protocol layer, before the service is ever called', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({
      name: 'list_work_items',
      arguments: { dueBefore: 'not-a-date' },
    });

    expect(result.isError).toBe(true);
    const content = (result.content as { type: string; text: string }[])[0];
    expect(content.text).toMatch(/ISO date/i);
    expect(workItemsService.listAllWorkItems).not.toHaveBeenCalled();

    await client.close();
  });

  // Regression test: the regex behind dueBefore's ISO_DATE schema only
  // checked the SHAPE (YYYY-MM-DD), not that the date is real — a
  // calendar-invalid value like "2026-13-99" or "2026-02-31" matched it
  // fine and reached workItems.service.ts's lte(workItems.dueDate, ...) raw,
  // where Postgres's own rejection (including the full SQL statement,
  // column names, and bound parameters) came back as the tool's error text.
  // ISO_DATE now has a .refine() that actually parses the string — this
  // must be rejected at the real protocol layer (zod's own tool-input
  // validation), before the service is ever called, exactly like the
  // shape-only "not-a-date" case above.
  it('rejects a calendar-invalid dueBefore (real shape, impossible date) at the protocol layer, before the service is ever called', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({
      name: 'list_work_items',
      arguments: { dueBefore: '2026-13-99' },
    });

    expect(result.isError).toBe(true);
    const content = (result.content as { type: string; text: string }[])[0];
    expect(content.text).not.toMatch(/postgres|SELECT|column|relation/i);
    expect(workItemsService.listAllWorkItems).not.toHaveBeenCalled();

    await client.close();
  });

  // MINOR regression test: search_work_items's query param previously had
  // no .min(1), so an empty string matched every work item's title (an
  // unscoped ilike(title, '%%') in workItems.service.ts) — effectively
  // turning "search" into "list everything" by accident.
  it('rejects an empty search_work_items query at the protocol layer', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({ name: 'search_work_items', arguments: { query: '' } });

    expect(result.isError).toBe(true);
    expect(workItemsService.searchWorkItems).not.toHaveBeenCalled();

    await client.close();
  });

  // MINOR regression test: .min(1) alone still let a whitespace-only query
  // (e.g. a single space) through, since " ".length is 1 — and that still
  // matched every work item's title the same way an empty string did, via
  // the underlying ilike('%<query>%', title). query is now .trim().min(1),
  // so a whitespace-only value must be rejected here too, not just a
  // literally empty one.
  it('rejects a whitespace-only search_work_items query at the protocol layer', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({ name: 'search_work_items', arguments: { query: '   ' } });

    expect(result.isError).toBe(true);
    expect(workItemsService.searchWorkItems).not.toHaveBeenCalled();

    await client.close();
  });

  // Sanity check for the same fix: a query that's meaningful once trimmed
  // (leading/trailing whitespace around real text) must still be accepted,
  // and the ACTUAL value reaching the service must be the trimmed one, not
  // the raw untrimmed string — proving zod's .trim() transform flows through
  // to the handler (see safeParseAsync in the MCP SDK, which hands the
  // handler parseResult.data, not the raw request arguments).
  it('trims surrounding whitespace from a search_work_items query before it reaches the service', async () => {
    vi.mocked(workItemsService.searchWorkItems).mockResolvedValue([]);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({ name: 'search_work_items', arguments: { query: '  login  ' } });

    expect(result.isError).toBeFalsy();
    expect(workItemsService.searchWorkItems).toHaveBeenCalledWith('login', undefined, expect.any(Number));

    await client.close();
  });

  // MINOR regression test: dueBefore's ISO_DATE schema accepted any year
  // 0000-9999 that was otherwise calendar-valid, including years Postgres's
  // `date` type itself rejects (e.g. "0000-01-01" throws a Postgres range
  // error) — reaching withErrorSafetyNet's generic "internal error" for what
  // is really a validation-catchable bad input. A sane year range is now
  // checked inside ISO_DATE's own .refine(), so this must be rejected at the
  // protocol layer with a real validation message, before the service (or
  // Postgres) is ever reached.
  it('rejects a dueBefore year far outside a sane range at the protocol layer', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({
      name: 'list_work_items',
      arguments: { dueBefore: '0000-01-01' },
    });

    expect(result.isError).toBe(true);
    const content = (result.content as { type: string; text: string }[])[0];
    expect(content.text).toMatch(/year/i);
    expect(workItemsService.listAllWorkItems).not.toHaveBeenCalled();

    await client.close();
  });

  // MAJOR regression test: this class of leak isn't specific to dueBefore —
  // any service-layer throw (a DB constraint, a timeout, a future bug)
  // previously reached the MCP SDK's own error serialization with its raw
  // `error.message`, which could contain arbitrary internal detail (driver
  // text, SQL, etc). Every registered tool handler is now wrapped
  // (withErrorSafetyNet in workItemTools.ts) so a thrown error becomes a
  // generic message instead — verified here through the real protocol
  // layer, not just by calling the handler function directly, so it proves
  // the wrapping is actually wired into registerWorkItemTools and not just
  // defined and unused.
  it('turns a thrown service-layer error into a generic message instead of leaking it to the client', async () => {
    vi.mocked(workItemsService.getWorkItem).mockRejectedValue(
      new Error('relation "work_items" violates constraint "fk_work_items_project_id" — DETAIL: Key (project_id)=(proj-1) is not present in table "projects".'),
    );

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({ name: 'get_work_item', arguments: { id: 'wi-1' } });

    expect(result.isError).toBe(true);
    const content = (result.content as { type: string; text: string }[])[0];
    expect(content.text).toBe('An internal error occurred while processing this request.');
    expect(content.text).not.toMatch(/relation|constraint|DETAIL|project_id/i);

    await client.close();
  });
});
