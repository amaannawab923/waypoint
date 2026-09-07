import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JiraCredential } from '../lib/jira/client.js';
import { registerTicketTools } from './ticketTools.js';
import { registerSprintTools } from './sprintTools.js';
import { registerProposalTools } from './proposalTools.js';

/**
 * Everything this request knows that the model did not tell it.
 *
 * Both fields arrive as headers (see mcp.routes.ts) and neither is any tool's
 * input, which is the property that matters: the model can no more choose
 * whose Jira it reads than it can choose which conversation its proposals
 * land in.
 */
export interface CopilotMcpContext {
  conversationId: string | null;
  /**
   * Borrowed for this request only. The one persisted Jira credential lives
   * in the desktop app's Electron main process — this holds a copy for the
   * life of one HTTP request and nothing writes it anywhere (see
   * lib/jira/credentialHeader.ts for why it works this way).
   */
  jiraCredential: JiraCredential | null;
}

// One server per request (see mcp.routes.ts) — cheap to construct, and
// avoids any cross-request state. Per-request construction is also what lets
// the request's own context be baked into the handlers: the conversation id
// (from x-waypoint-conversation-id) into the propose_* tools, and the Jira
// credential (from x-waypoint-jira-credential) into the read tools. With
// neither present the server still registers every tool and each refuses
// cleanly in its own terms — proposals unavailable, Jira not connected.
//
// The per-request lifetime is exactly why a borrowed credential is safe to
// hold at all: this object is closed when the response closes (res.on('close')
// in mcp.routes.ts), so the credential's lifetime is the request's.
export function createCopilotMcpServer(
  context: CopilotMcpContext = { conversationId: null, jiraCredential: null },
): McpServer {
  const server = new McpServer({ name: 'waypoint', version: '2.0.0' });
  registerTicketTools(server, context.jiraCredential);
  registerSprintTools(server);
  registerProposalTools(server, context.conversationId);
  return server;
}
