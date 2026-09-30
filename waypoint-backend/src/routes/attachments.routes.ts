import { Router, type NextFunction, type Request, type Response } from 'express';
import express from 'express';
import { pipeline } from 'node:stream/promises';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { PayloadTooLargeError } from '../middleware/errors.js';
import { decodeFilenameHeader, normalizeMimeType } from '../lib/attachmentStore.js';
import * as attachmentsService from '../services/attachments.service.js';

export const attachmentsRouter = Router();

/**
 * 25 MB. Large enough for the screenshots, logs, and PDFs a ticket
 * attracts; small enough that a single request can still be buffered in
 * memory without turning an upload into a denial of service.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** The upload route's path. Exported so app.ts can keep its app-wide JSON
 * parser off this one route; see the comment there. */
export const ATTACHMENT_UPLOAD_PATH = /^\/tickets\/[^/]+\/attachments\/?$/;

// The upload body is raw file bytes, not JSON and not multipart — the
// client already knows the filename (header) and the type (content-type),
// so there is nothing a multipart envelope would add except a parser
// dependency and its own decade of CVEs.
//
// `type: () => true` rather than a content-type matcher: body-parser skips
// a body whose type doesn't match, which would silently hand the handler
// an empty req.body for an upload that simply omitted content-type.
const rawUploadBody = express.raw({ type: () => true, limit: MAX_ATTACHMENT_BYTES });

/**
 * Mounted ON THIS ROUTE ONLY, never app-wide. A raw parser installed
 * globally consumes the body of every request before express.json() ever
 * sees it, which breaks every other endpoint in the API.
 *
 * body-parser's own PayloadTooLargeError already carries `.status: 413`
 * and `.type: 'entity.too.large'`, which errorHandler.ts's
 * trustedHttpStatus() path turns into a clean `request_too_large` — but
 * that response says nothing about what the limit IS, and "too large" with
 * no number is a support ticket. Re-thrown here with a readable message
 * and the same 413.
 */
function uploadBody(req: Request, res: Response, next: NextFunction): void {
  rawUploadBody(req, res, (err?: unknown) => {
    if (err && (err as { type?: string }).type === 'entity.too.large') {
      next(new PayloadTooLargeError(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit.`));
      return;
    }
    next(err);
  });
}

attachmentsRouter.post(
  '/tickets/:ticketId/attachments',
  uploadBody,
  asyncHandler(async (req, res) => {
    // Buffer.isBuffer, not a truthiness check: express.raw() leaves req.body
    // as `{}` when there was nothing to parse, and `{}.length` is undefined
    // rather than 0 — which would sail past an emptiness check and land an
    // `undefined` in sizeBytes.
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const attachment = await attachmentsService.uploadAttachment(req.params.ticketId, {
      filename: decodeFilenameHeader(req.headers['x-waypoint-filename']),
      mimeType: normalizeMimeType(req.headers['content-type']),
      bytes,
    });
    res.status(201).json(attachment);
  }),
);

attachmentsRouter.get(
  '/tickets/:ticketId/attachments',
  asyncHandler(async (req, res) => {
    res.json(await attachmentsService.listTicketAttachments(req.params.ticketId));
  }),
);

/** Serves the bytes. `preferInline` is only ever a request — the service
 * downgrades anything outside its inline allowlist to a download, so the
 * two routes below differ in what they ask for, never in what is safe. */
async function serveAttachment(req: Request, res: Response, preferInline: boolean): Promise<void> {
  const { contentType, disposition, sizeBytes, stream } = await attachmentsService.openAttachmentForResponse(
    req.params.id,
    preferInline,
    // The signature an <img src> carries in place of the headers it
    // cannot send — see lib/attachmentTokens.ts.
    req.query.t,
  );
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', disposition);
  res.setHeader('Content-Length', sizeBytes);
  // Without nosniff, a browser may ignore the Content-Type above and
  // sniff the BYTES — which is exactly how a file declared text/plain gets
  // rendered as HTML on this API's own origin.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Defence in depth for the inline case: even a type on the allowlist
  // renders with no ability to load or run anything.
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  // Uploaded content is workspace-scoped; no shared cache may keep a copy.
  res.setHeader('Cache-Control', 'private, no-store');
  // pipeline, not stream.pipe: it destroys the read stream if the client
  // disconnects mid-download, which a bare pipe leaks.
  await pipeline(stream, res);
}

attachmentsRouter.get(
  '/attachments/:id',
  asyncHandler(async (req, res) => {
    await serveAttachment(req, res, true);
  }),
);

attachmentsRouter.get(
  '/attachments/:id/download',
  asyncHandler(async (req, res) => {
    await serveAttachment(req, res, false);
  }),
);

attachmentsRouter.delete(
  '/attachments/:id',
  asyncHandler(async (req, res) => {
    await attachmentsService.deleteAttachment(req.params.id);
    res.status(204).end();
  }),
);
