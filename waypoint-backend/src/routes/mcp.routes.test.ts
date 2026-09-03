import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
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
// db carries callable fns (not just {}) because the V2 proposal tests below
// run the REAL proposals.service against an in-memory stand-in for the
// proposals table — see installProposalStore(). The V1 read-tool tests
// never touch db, exactly as before.
vi.mock('../db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../services/tickets.service.js');
vi.mock('../services/states.service.js');
vi.mock('../services/comments.service.js');
vi.mock('../services/members.service.js');
vi.mock('../services/projects.service.js');
vi.mock('../lib/actorNames.js');
const { db } = await import('../db/client.js');
const ticketsService = await import('../services/tickets.service.js');
const { resolveStateNames } = await import('../services/states.service.js');
const commentsService = await import('../services/comments.service.js');
const membersService = await import('../services/members.service.js');
const { mcpRouter } = await import('./mcp.routes.js');
const { proposalsRouter } = await import('./proposals.routes.js');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(mcpRouter);
  // Mounted alongside the MCP router so the write-approval flow can be
  // driven END-TO-END in one app: the model's propose_* tool call over the
  // real MCP protocol, then the user's approve over the real REST route.
  app.use(proposalsRouter);
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
    vi.mocked(ticketsService.listAllTickets).mockResolvedValue([
      { id: 'wi-1', identifier: 'WI-1', title: 'Fix login bug', projectId: 'proj-1', stateId: 'state-1', priority: 'high', assigneeIds: [] } as never,
    ]);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({ name: 'list_work_items', arguments: {} });

    expect(ticketsService.listAllTickets).toHaveBeenCalled();
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
    vi.mocked(ticketsService.getTicket).mockResolvedValue(undefined);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({ name: 'get_work_item', arguments: { id: 'missing' } });

    expect(result.isError).toBe(true);
    await client.close();
  });

  // Regression test: dueBefore's inputSchema previously accepted any
  // string, so a malformed value reached tickets.service.ts's
  // lte(tickets.dueDate, ...) raw and could leak a Postgres error string
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
    expect(ticketsService.listAllTickets).not.toHaveBeenCalled();

    await client.close();
  });

  // Regression test: the regex behind dueBefore's ISO_DATE schema only
  // checked the SHAPE (YYYY-MM-DD), not that the date is real — a
  // calendar-invalid value like "2026-13-99" or "2026-02-31" matched it
  // fine and reached tickets.service.ts's lte(tickets.dueDate, ...) raw,
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
    expect(ticketsService.listAllTickets).not.toHaveBeenCalled();

    await client.close();
  });

  // MINOR regression test: search_work_items's query param previously had
  // no .min(1), so an empty string matched every ticket's title (an
  // unscoped ilike(title, '%%') in tickets.service.ts) — effectively
  // turning "search" into "list everything" by accident.
  it('rejects an empty search_work_items query at the protocol layer', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({ name: 'search_work_items', arguments: { query: '' } });

    expect(result.isError).toBe(true);
    expect(ticketsService.searchTickets).not.toHaveBeenCalled();

    await client.close();
  });

  // MINOR regression test: .min(1) alone still let a whitespace-only query
  // (e.g. a single space) through, since " ".length is 1 — and that still
  // matched every ticket's title the same way an empty string did, via
  // the underlying ilike('%<query>%', title). query is now .trim().min(1),
  // so a whitespace-only value must be rejected here too, not just a
  // literally empty one.
  it('rejects a whitespace-only search_work_items query at the protocol layer', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({ name: 'search_work_items', arguments: { query: '   ' } });

    expect(result.isError).toBe(true);
    expect(ticketsService.searchTickets).not.toHaveBeenCalled();

    await client.close();
  });

  // Sanity check for the same fix: a query that's meaningful once trimmed
  // (leading/trailing whitespace around real text) must still be accepted,
  // and the ACTUAL value reaching the service must be the trimmed one, not
  // the raw untrimmed string — proving zod's .trim() transform flows through
  // to the handler (see safeParseAsync in the MCP SDK, which hands the
  // handler parseResult.data, not the raw request arguments).
  it('trims surrounding whitespace from a search_work_items query before it reaches the service', async () => {
    vi.mocked(ticketsService.searchTickets).mockResolvedValue([]);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const result = await client.callTool({ name: 'search_work_items', arguments: { query: '  login  ' } });

    expect(result.isError).toBeFalsy();
    expect(ticketsService.searchTickets).toHaveBeenCalledWith('login', undefined, expect.any(Number));

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
    expect(ticketsService.listAllTickets).not.toHaveBeenCalled();

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
    vi.mocked(ticketsService.getTicket).mockRejectedValue(
      new Error('relation "tickets" violates constraint "fk_tickets_project_id" — DETAIL: Key (project_id)=(proj-1) is not present in table "projects".'),
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

// ---------------------------------------------------------------------------
// Copilot V2 write proposals — the same real-protocol standard as above, now
// for the propose_* tools: the conversation id must arrive via the transport
// header (never tool input), and the full propose → approve → execute flow
// must hold its single-execution guarantee end-to-end.
// ---------------------------------------------------------------------------

const CONVERSATION_HEADERS = { 'x-waypoint-conversation-id': 'conv-abc1234' };

function connectClient(headers?: Record<string, string>) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    ...(headers ? { requestInit: { headers } } : {}),
  });
  return client.connect(transport).then(() => client);
}

function visibleTicket() {
  return {
    id: 'wi-1',
    projectId: 'proj-1',
    identifier: 'WI-1',
    title: 'A ticket',
    stateId: 'st-progress',
    priority: 'medium',
    isDraft: false,
    assigneeIds: [],
    updatedAt: new Date('2026-01-02T03:04:05.000Z'),
  } as never;
}

// Minimal fluent-chain fake, same shape as the service tests'.
function chainable(resolvedValue: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'limit', 'orderBy', 'values', 'set']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.returning = vi.fn(() => Promise.resolve(resolvedValue));
  chain.then = (resolve: (value: unknown) => void) => resolve(resolvedValue);
  return chain;
}

// An in-memory, single-row stand-in for the copilot_proposals table, wired
// under the REAL proposals.service: createProposal's transaction stores the
// inserted row; approve's claim UPDATE only wins while the row is still
// 'proposed' (the real single-execution semantics); every other UPDATE
// applies its set() onto the row; the fallback SELECT echoes it. What the
// service-layer unit tests prove with condition spies, this proves as
// behavior across the real MCP + REST wiring.
function installProposalStore() {
  const store: { row: Record<string, unknown> | null } = { row: null };

  vi.mocked(db.transaction).mockImplementation(async (callback: (tx: unknown) => unknown) => {
    let selectCall = 0;
    const selectResults = [[{ id: 'conv-abc1234' }], [{ maxSeq: '3' }], [{ n: 0 }], [{ n: 0 }]];
    const tx = {
      select: vi.fn(() => chainable(selectResults[selectCall++] ?? [])),
      update: vi.fn(() => chainable(undefined)),
      insert: vi.fn(() => {
        const chain = chainable(undefined);
        const capture = chain.values as ReturnType<typeof vi.fn>;
        chain.returning = vi.fn(() => {
          store.row = {
            status: 'proposed',
            statusReason: null,
            resultInfo: null,
            modelNotifiedAt: null,
            resolvedAt: null,
            createdAt: new Date(),
            ...capture.mock.calls[0][0],
          };
          return Promise.resolve([{ ...store.row }]);
        });
        return chain;
      }),
    };
    return callback(tx);
  });

  vi.mocked(db.update).mockImplementation(() => {
    const chain = chainable(undefined);
    const captureSet = chain.set as ReturnType<typeof vi.fn>;
    chain.returning = vi.fn(() => {
      const patch = captureSet.mock.calls[0][0] as Record<string, unknown>;
      if (!store.row) return Promise.resolve([]);
      if (patch.status === 'executing') {
        if (store.row.status !== 'proposed') return Promise.resolve([]);
        Object.assign(store.row, patch);
        return Promise.resolve([{ ...store.row }]);
      }
      Object.assign(store.row, patch);
      return Promise.resolve([{ ...store.row }]);
    });
    return chain as never;
  });

  vi.mocked(db.select).mockImplementation(
    () => chainable(store.row ? [{ ...store.row }] : []) as never,
  );

  return store;
}

describe('POST /mcp/copilot — V2 write proposals', () => {
  it('delivers the conversation id via the transport header into the stored proposal row — never via tool input', async () => {
    const store = installProposalStore();
    vi.mocked(ticketsService.getTicket).mockResolvedValue(visibleTicket());
    const client = await connectClient(CONVERSATION_HEADERS);

    const result = await client.callTool({
      name: 'propose_comment',
      arguments: { ticketId: 'wi-1', body: 'summarizing the fix' },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as { text: string }[])[0].text);
    expect(parsed.status).toBe('pending_user_approval');
    expect(parsed.proposalId).toMatch(/^prop-/);
    expect(store.row).toMatchObject({
      conversationId: 'conv-abc1234',
      kind: 'comment',
      payload: { body: 'summarizing the fix' },
    });

    await client.close();
  });

  it('refuses proposing cleanly when the header is absent, while read tools keep working', async () => {
    vi.mocked(ticketsService.getTicket).mockResolvedValue(visibleTicket());
    vi.mocked(ticketsService.listAllTickets).mockResolvedValue([]);
    const client = await connectClient();

    const propose = await client.callTool({
      name: 'propose_comment',
      arguments: { ticketId: 'wi-1', body: 'hi' },
    });
    expect(propose.isError).toBe(true);
    expect((propose.content as { text: string }[])[0].text).toBe(
      'Proposals are unavailable in this session.',
    );
    expect(db.transaction).not.toHaveBeenCalled();

    const read = await client.callTool({ name: 'list_work_items', arguments: {} });
    expect(read.isError).toBeFalsy();

    await client.close();
  });

  it('refuses proposing for a malformed header value (pattern re-validated server-side)', async () => {
    const client = await connectClient({ 'x-waypoint-conversation-id': 'conv-$(rm -rf /)' });

    const result = await client.callTool({
      name: 'propose_comment',
      arguments: { ticketId: 'wi-1', body: 'hi' },
    });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toBe(
      'Proposals are unavailable in this session.',
    );

    await client.close();
  });

  it('rejects a malformed propose_comment (empty body) at the protocol layer, before any handler runs', async () => {
    const client = await connectClient(CONVERSATION_HEADERS);

    const result = await client.callTool({
      name: 'propose_comment',
      arguments: { ticketId: 'wi-1', body: '   ' },
    });

    expect(result.isError).toBe(true);
    expect(ticketsService.getTicket).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();

    await client.close();
  });

  it('scrubs a service-layer throw inside a propose handler to the generic internal-error message', async () => {
    vi.mocked(ticketsService.getTicket).mockRejectedValue(
      new Error('relation "copilot_proposals" violates constraint "fk" — DETAIL: everything'),
    );
    const client = await connectClient(CONVERSATION_HEADERS);

    const result = await client.callTool({
      name: 'propose_comment',
      arguments: { ticketId: 'wi-1', body: 'hi' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toBe('An internal error occurred while processing this request.');
    expect(text).not.toMatch(/relation|constraint|DETAIL/i);

    await client.close();
  });

  it('END-TO-END: propose over MCP, approve over REST executes the disclosure-prefixed comment exactly once; a second approve does not re-execute', async () => {
    installProposalStore();
    vi.mocked(ticketsService.getTicket).mockResolvedValue(visibleTicket());
    vi.mocked(membersService.getCurrentUser).mockResolvedValue({ displayName: 'Amaan' } as never);
    vi.mocked(commentsService.addComment).mockResolvedValue({ id: 'cm-1' } as never);
    const client = await connectClient(CONVERSATION_HEADERS);

    // 1. The model proposes — nothing executes.
    const proposeResult = await client.callTool({
      name: 'propose_comment',
      arguments: { ticketId: 'wi-1', body: 'Fixed by removing the breakpoint override.' },
    });
    const { proposalId } = JSON.parse((proposeResult.content as { text: string }[])[0].text);
    expect(commentsService.addComment).not.toHaveBeenCalled();

    // 2. The user approves — the comment posts exactly once, with the
    // server-added disclosure prefix and the model's body escaped after it.
    const approve = await request(httpServer).post(`/copilot/proposals/${proposalId}/approve`).send({});
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe('executed');
    expect(approve.body.resultInfo).toEqual({ commentId: 'cm-1' });
    expect(commentsService.addComment).toHaveBeenCalledTimes(1);
    const [ticketId, html] = vi.mocked(commentsService.addComment).mock.calls[0];
    expect(ticketId).toBe('wi-1');
    expect(
      html.startsWith('<p><em>Hi, this is Copilot — Amaan’s agent — commenting on their behalf: </em>'),
    ).toBe(true);
    expect(html).toContain('Fixed by removing the breakpoint override.');

    // 3. A second approve (double-click, retried request) echoes the
    // executed row and does NOT post again.
    const again = await request(httpServer).post(`/copilot/proposals/${proposalId}/approve`).send({});
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('executed');
    expect(commentsService.addComment).toHaveBeenCalledTimes(1);

    await client.close();
  });
});
