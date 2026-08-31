import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWorkItemTools } from './workItemTools.js';

// One server per request (see mcp.routes.ts) — cheap to construct, and
// avoids any cross-request state, matching this tool set being pure reads.
export function createCopilotMcpServer(): McpServer {
  const server = new McpServer({ name: 'waypoint', version: '1.0.0' });
  registerWorkItemTools(server);
  return server;
}
