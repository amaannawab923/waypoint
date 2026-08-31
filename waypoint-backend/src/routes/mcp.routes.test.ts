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
const workItemsService = await import('../services/workItems.service.js');
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
      { id: 'wi-1', identifier: 'WI-1', title: 'Fix login bug', stateId: 'state-1', priority: 'high', assigneeIds: [] } as never,
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
          stateId: 'state-1',
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
});
