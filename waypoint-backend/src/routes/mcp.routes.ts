import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createCopilotMcpServer } from '../mcp/server.js';

export const mcpRouter = Router();

// Mirrors copilotRunner.ts's CONVERSATION_ID_PATTERN and lib/ids.ts's
// newId('conv') shape. Re-validated here even though the runner already
// validated before emitting the header — the HTTP endpoint is reachable by
// anything on localhost, so a malformed/hostile header value must degrade
// to "no conversation" (propose tools refuse cleanly) rather than flow into
// SQL as an arbitrary string.
const CONVERSATION_ID_PATTERN = /^conv-[a-z0-9]{4,32}$/i;

// Stateless: a fresh McpServer + transport per request, no session to
// manage. The spawned `claude` CLI subprocess (copilotRunner.ts) is the
// only caller in practice, over --mcp-config's http transport — which is
// also where the x-waypoint-conversation-id header originates (a static
// `headers` entry in the runner's --mcp-config, sent on every POST). The
// conversation id rides a header rather than any tool's input schema so the
// model can never choose which conversation its proposals land in.
mcpRouter.post(
  '/mcp/copilot',
  asyncHandler(async (req, res) => {
    const rawConversationId = req.header('x-waypoint-conversation-id');
    const conversationId =
      rawConversationId && CONVERSATION_ID_PATTERN.test(rawConversationId) ? rawConversationId : null;
    const server = createCopilotMcpServer({ conversationId });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }),
);
