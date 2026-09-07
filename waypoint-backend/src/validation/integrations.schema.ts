import { z } from 'zod';

// The hostname itself is validated in jiraConnection.service.ts's
// normalizeSite(), not here: what makes a site address acceptable is a
// security question about where an authenticated request will actually be
// sent, and it belongs next to the code that pins the URL, in one place, not
// duplicated into a regex that could drift from it. This schema's job is only
// to establish that three non-empty strings arrived.
export const connectJiraSchema = z.object({
  site: z.string().trim().min(1),
  email: z.string().trim().min(1),
  // No .trim(): an API token is an opaque credential, and silently editing
  // one before sending it produces a 401 the user cannot explain. Leading or
  // trailing whitespace in a paste is Jira's to reject.
  //
  // The cap is a denial-of-service bound, not a format claim — Atlassian's
  // tokens are ~200 characters and nothing legitimate approaches this.
  apiToken: z.string().min(1).max(4096),
});
