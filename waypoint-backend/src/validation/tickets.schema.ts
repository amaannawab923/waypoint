import { z } from 'zod';
import { escapeHtml } from '../lib/commentHtml.js';

// Exported so other validation modules (e.g. ticketFilter.schema.ts) reuse
// the same literal set instead of redeclaring it.
export const prioritySchema = z.enum(['urgent', 'high', 'medium', 'low', 'none']);
const priority = prioritySchema;

export const createTicketSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  stateId: z.string(),
  priority: priority.optional(),
  assigneeIds: z.array(z.string()).optional(),
  labelIds: z.array(z.string()).optional(),
  workstreamId: z.string().nullable().optional(),
  sprintId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  isDraft: z.boolean().optional(),
});

export const updateTicketSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  stateId: z.string().optional(),
  priority: priority.optional(),
  assigneeIds: z.array(z.string()).optional(),
  labelIds: z.array(z.string()).optional(),
  workstreamId: z.string().nullable().optional(),
  sprintId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  estimatePoints: z.number().nullable().optional(),
  estimateValue: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  isDraft: z.boolean().optional(),
});

export const reorderTicketSchema = z.object({
  targetId: z.string(),
  position: z.enum(['before', 'after']),
});

// Only http:/https:/mailto: are accepted — a ticket link is rendered as a
// clickable <a href> in the frontend, and (see waypoint-frontend's main.ts
// setWindowOpenHandler / will-navigate guard) opened via shell.openExternal,
// so a javascript:/file:/other custom scheme here would be a real code- or
// local-file-execution vector, not just a broken link.
const LINK_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export const addTicketLinkSchema = z.object({
  url: z.string().refine(
    (value) => {
      try {
        return LINK_URL_SCHEMES.has(new URL(value).protocol);
      } catch {
        return false;
      }
    },
    { message: 'url must be an http:, https:, or mailto: link' },
  ),
  label: z.string(),
});

// bodyHtml arrives here as raw, unsanitized input from any REST caller —
// unlike the Copilot path (buildCopilotCommentHtml in lib/commentHtml.ts),
// which only ever escapes model-authored plain text before wrapping it in a
// fixed <p>/<em> template, this field had no equivalent treatment: a
// human (or anyone hitting the REST API directly) could store a raw
// <script> tag or a javascript:/file: href in bodyHtml, which is a stored
// XSS payload the moment any renderer (present or future) trusts this field
// enough to use dangerouslySetInnerHTML on it — exactly what the Copilot
// comment path already does for its own bodyHtml. Escaping here, with the
// SAME escapeHtml primitive commentHtml.ts uses, neutralizes that at the
// validation boundary, before the value is ever persisted, matching the
// Copilot path's posture: a comment body is prose, not rich content.
// Deliberately NOT done inside comments.service.ts's addComment() — that
// function is also called with already-built, already-safe HTML from the
// Copilot path (proposals.service.ts) and from agentAssignments.service.ts;
// escaping there a second time would corrupt those callers' real <p>/<em>
// tags into literal, visible entities instead of leaving them as-is.
export const addCommentSchema = z.object({
  bodyHtml: z
    .string()
    .min(1)
    .transform((value) => escapeHtml(value)),
});
