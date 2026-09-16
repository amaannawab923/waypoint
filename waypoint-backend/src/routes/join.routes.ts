import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { configuredAuthMethods } from '../lib/authMethods.js';
import { getInvitePreview } from '../services/workspaces.service.js';
import { renderJoinPreviewPage } from '../auth/joinPage.js';
import { renderErrorPage } from '../auth/signInPage.js';

// AT12 (ROAD-147). The invitee's landing page — spec §7 step 10. Public,
// unauthenticated (no resolveMember/requireUser involved at all — this is
// how someone who has never signed in before gets started). Renders HTML,
// same convention as auth.routes.ts's browser-facing routes: a person in
// a browser is on the other end, and a bad/expired/already-used token
// becomes an error page, never a JSON error a browser tab can't do
// anything with.
export const joinRouter = Router();

joinRouter.get(
  '/join/:token',
  asyncHandler(async (req, res) => {
    const html = (status: number, body: string) => res.status(status).type('html').send(body);
    let preview: Awaited<ReturnType<typeof getInvitePreview>>;
    try {
      preview = await getInvitePreview(req.params.token);
    } catch (err) {
      const status = (err as { name?: string }).name === 'NotFoundError' ? 404 : 400;
      html(status, renderErrorPage(err instanceof Error ? err.message : 'This invite link is no longer valid.'));
      return;
    }
    html(
      200,
      renderJoinPreviewPage({
        workspaceName: preview.workspaceName,
        inviterName: preview.inviterName,
        token: req.params.token,
        methods: configuredAuthMethods(process.env),
      }),
    );
  }),
);
