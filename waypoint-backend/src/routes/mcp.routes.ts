import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  JIRA_CREDENTIAL_HEADER,
  parseJiraCredentialHeader,
} from '../lib/jira/credentialHeader.js';
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
// also where both headers below originate (static `headers` entries in the
// runner's --mcp-config, sent on every POST). Each rides a header rather
// than any tool's input schema for the same reason: the model can never
// choose which conversation its proposals land in, and can never choose
// whose Jira it reads.
//
// The Jira credential is BORROWED, not stored. This process keeps no Jira
// credential of its own — the one that exists lives in the desktop app's
// Electron main process, and arrives here per request precisely so that
// stays true (see lib/jira/credentialHeader.ts). It is parsed into the
// request's context and goes away with the response.
mcpRouter.post(
  '/mcp/copilot',
  asyncHandler(async (req, res) => {
    const rawConversationId = req.header('x-waypoint-conversation-id');
    const conversationId =
      rawConversationId && CONVERSATION_ID_PATTERN.test(rawConversationId) ? rawConversationId : null;
    // Absent, malformed, and hostile all parse to null, which is the state
    // the read tools already handle ("Jira is not connected") — there is
    // deliberately no error path here for a bad credential header.
    const jiraCredential = parseJiraCredentialHeader(req.header(JIRA_CREDENTIAL_HEADER));
    const server = createCopilotMcpServer({ conversationId, jiraCredential });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Both close() calls return Promise<void> — an unhandled rejection from
    // either would, under Node's default behavior, crash this whole
    // single-process backend (no supervisor). This is a best-effort
    // teardown on connection close, not a request the caller is waiting on,
    // so a failure here is swallowed rather than propagated.
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }),
);
