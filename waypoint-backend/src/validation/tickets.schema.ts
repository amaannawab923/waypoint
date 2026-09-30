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
// POST comment handler — the only caller of this schema for a person-typed
// comment). Unlike the Copilot path (buildCopilotCommentHtml in
// lib/commentHtml.ts), which escapes model-authored text before wrapping it
// in a fixed <p>/<em> template for rendering via dangerouslySetInnerHTML, a
// human-authored comment's bodyHtml is stored as exactly what was typed —
// markdown SOURCE, not HTML, despite the column's name (kept for now rather
// than a rename that would touch every reader and writer for no behavior
// change). Running it through escapeHtml here would double-escape it: a
// comment containing `don't` would round-trip as `don&amp;#39;t` instead of
// `don't`. So this schema deliberately does NOT escape bodyHtml — safety
// comes from the render side (TicketDetailPage.tsx's comment list renders
// the human branch through renderMarkdown, from lib/markdown.ts, which
// escapes every HTML metacharacter before it ever emits its own fixed
// vocabulary — see that function's own comment), not from validation here.
//
// ROAD-162: parentId threads a reply one level deep — see
// groupCommentsIntoThreads (lib/commentThreads.ts) for how a chain deeper
// than one hop, or a parent that doesn't exist, still renders honestly
// rather than getting silently dropped. Validated against the ticket's own
// comments in the service (addComment), not here: a schema has no database
// to check a real id against.
//
// ROAD-162 attachments: `attachmentIds` names files already uploaded
// against this ticket (POST /tickets/:id/attachments) that this comment
// claims. Defaulted to [] rather than left optional so the service always
// receives an array — "no files" and "field omitted" mean the same thing
// when a comment is being CREATED (there is nothing yet to preserve),
// which is exactly what is NOT true on edit below. Bounded so a single
// request can't name a hundred thousand ids; membership in this ticket is
// checked in the service, which has a database, not here.
const attachmentIdList = z.array(z.string().min(1)).max(50);

/**
 * The longest comment body accepted, in characters. The same ceiling Jira
 * puts on a comment, so nothing synced from or written for Jira is cut
 * short. It matters beyond tidiness: every workspace member's comment is
 * rendered on every reader's screen, so an unbounded body is a way to make
 * a ticket page slow for everyone. (Review found a ~20 KB comment that took
 * a page down entirely; the renderer is now linear-time as well, but this
 * cap is what keeps even linear work small.)
 */
export const COMMENT_BODY_MAX_LENGTH = 32_767;

const commentBody = z
  .string()
  .max(COMMENT_BODY_MAX_LENGTH, `Comments are limited to ${COMMENT_BODY_MAX_LENGTH.toLocaleString('en-US')} characters.`);

export const addCommentSchema = z
  .object({
    // May be empty when the comment carries files: a screenshot with
    // nothing to say about it is a real comment.
    bodyHtml: commentBody,
    parentId: z.string().nullable().optional(),
    attachmentIds: attachmentIdList.default([]),
  })
  .refine((v) => v.bodyHtml.trim() !== '' || v.attachmentIds.length > 0, {
    message: 'A comment needs text or at least one attachment.',
    path: ['bodyHtml'],
  });

// The edit path (PATCH /tickets/:id/comments/:commentId) — same
// deliberately-unescaped bodyHtml as addCommentSchema above, and the same
// reasoning. Author-only enforcement is NOT expressible here (this schema
// has no notion of "who is asking"); comments.service.ts's editComment
// checks currentMemberId() against the existing row and throws
// ForbiddenError, matching the "no role-based authz layer" fact this
// backend already lives with (see ForbiddenError's own comment in
// middleware/errors.ts).
//
// ROAD-162: `attachmentIds` here is OPTIONAL with no default, and the
// difference from addCommentSchema's `.default([])` is the whole
// semantics. Present, it is the full set of attachments after the edit
// (anything currently on the comment and missing from it is deleted, see
// claimAttachmentsForComment); absent, the comment's attachments are left
// untouched.
// Defaulting it to [] would silently strip every file off any comment
// edited by a client that only sends text.
// bodyHtml may be empty only if the comment keeps at least one file after
// the edit. That depends on what the comment already carries, which this
// schema can't see, so comments.service.ts's editComment enforces it.
export const editCommentSchema = z.object({
  bodyHtml: commentBody,
  attachmentIds: attachmentIdList.optional(),
  // The comment's version (updatedAt, or createdAt if never edited) as the
  // client saw it when the edit began. See editComment for why.
  expectedVersion: z.string().max(64).optional(),
});
