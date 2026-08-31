import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createCopilotMcpServer } from '../mcp/server.js';

export const mcpRouter = Router();

// Stateless: a fresh McpServer + transport per request, no session to
// manage — this tool set is pure reads, so there's no state worth keeping
// between calls. The spawned `claude` CLI subprocess (copilotRunner.ts) is
// the only caller in practice, over --mcp-config's http transport.
mcpRouter.post(
  '/mcp/copilot',
  asyncHandler(async (req, res) => {
    const server = createCopilotMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }),
);
