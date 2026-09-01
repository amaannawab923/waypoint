import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWorkItemTools } from './workItemTools.js';
import { registerProposalTools } from './proposalTools.js';

// One server per request (see mcp.routes.ts) — cheap to construct, and
// avoids any cross-request state. Per-request construction is also what
// lets the request's own conversation id (from the x-waypoint-conversation-id
// header) be baked into the propose_* handlers as context: the id is
// deliberately NOT a tool input, so the model can never supply or spoof it.
// With no (or an invalid) conversation id, the propose tools still register
// but refuse cleanly — read tools are unaffected.
export function createCopilotMcpServer(
  context: { conversationId: string | null } = { conversationId: null },
): McpServer {
  const server = new McpServer({ name: 'waypoint', version: '2.0.0' });
  registerWorkItemTools(server);
  registerProposalTools(server, context.conversationId);
  return server;
}
