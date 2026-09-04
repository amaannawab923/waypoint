import { z } from 'zod';

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

// bodyHtml arrives here as raw, unsanitized input from any REST caller, and
// this is the human-authored comment path (see routes/tickets.routes.ts's
// POST comment handler — the only caller of this schema). Unlike the
// Copilot path (buildCopilotCommentHtml in lib/commentHtml.ts), which
// escapes model-authored text before wrapping it in a fixed <p>/<em>
// template for rendering via dangerouslySetInnerHTML, a human-authored
// comment is rendered by the frontend as a PLAIN TEXT node (see
// TicketDetailPage.tsx's comment list: the non-agent branch renders
// {c.bodyHtml} directly as a JSX child, which React escapes on its own at
// render time — no dangerouslySetInnerHTML, no HTML parsing). Running
// bodyHtml through escapeHtml here as well would double-escape it: a
// comment containing `don't` would round-trip as `don&amp;#39;t` instead of
// `don't`. So this schema deliberately does NOT escape bodyHtml — the
// plain-text render path is what neutralizes it, not validation.
export const addCommentSchema = z.object({
  bodyHtml: z.string().min(1),
});
