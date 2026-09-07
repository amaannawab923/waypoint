import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as jiraConnection from '../services/jiraConnection.service.js';
import { connectJiraSchema } from '../validation/integrations.schema.js';
import type { JiraFailureReason } from '../lib/jira/client.js';

export const integrationsRouter = Router();

/**
 * Which HTTP status a Jira failure deserves.
 *
 * Jira's rejection of a credential is not this server's error, and returning
 * 500 for it would make a typed API token look like a bug in Waypoint. 502
 * for the reasons that genuinely mean "the upstream had a problem" keeps that
 * distinction visible in logs and in the UI, where the two need different
 * words: fix what you typed, versus try again later.
 */
function statusForReason(reason: JiraFailureReason): number {
  switch (reason) {
    case 'invalid_credentials':
      return 401;
    case 'forbidden':
      return 403;
    case 'not_found':
      return 404;
    case 'site_not_found':
      return 400;
    case 'rate_limited':
      return 429;
    default:
      return 502;
  }
}

integrationsRouter.get(
  '/integrations/jira',
  asyncHandler(async (_req, res) => {
    res.json(await jiraConnection.getStatus());
  }),
);

// POST, not PUT: there is one connection, so this reads as "connect Jira"
// rather than "replace the Jira resource", and it is deliberately not
// idempotent in the sense that matters — every call re-proves the credential
// against Jira before it is stored (see connect()).
//
// The request body carries an API token, which is why this endpoint exists at
// all rather than the token being configured through an env var: a user
// pasting a token into the app is the flow, and it is the one place in this
// API where the body must never be logged. Nothing here logs it; the audit
// line below deliberately records only that a connect was attempted and to
// which site.
integrationsRouter.post(
  '/integrations/jira',
  asyncHandler(async (req, res) => {
    const input = connectJiraSchema.parse(req.body ?? {});
    console.log(`[integrations] jira connect requested for site: ${input.site}`);
    const result = await jiraConnection.connect(input);
    if (!result.ok) {
      res.status(statusForReason(result.reason)).json({ error: result.reason, message: result.message });
      return;
    }
    res.json(result.value);
  }),
);

// Re-proves the STORED credential. Separate from POST because the useful
// question ("is the connection I already have still good?") cannot be asked
// by re-submitting a token the user no longer has in front of them.
integrationsRouter.post(
  '/integrations/jira/test',
  asyncHandler(async (_req, res) => {
    const result = await jiraConnection.test();
    if (!result.ok) {
      res.status(statusForReason(result.reason)).json({ error: result.reason, message: result.message });
      return;
    }
    res.json(result.value);
  }),
);

// 200 with the resulting status, not 204: disconnecting is exactly when a
// caller wants to render the now-disconnected state, and making it re-fetch
// to find out what it just did is a round trip for nothing. Idempotent —
// disconnecting an absent connection is a success, since the requested end
// state is the state.
integrationsRouter.delete(
  '/integrations/jira',
  asyncHandler(async (_req, res) => {
    await jiraConnection.disconnect();
    res.json(await jiraConnection.getStatus());
  }),
);
