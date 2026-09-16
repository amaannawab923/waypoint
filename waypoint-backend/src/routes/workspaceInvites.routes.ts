import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as workspacesService from '../services/workspaces.service.js';
import { createInviteSchema } from '../validation/workspace.schema.js';
import { publicBaseUrl } from '../auth/redirect.js';

// AT12 (ROAD-147). Distinct from workspaces.routes.ts's collection routes
// (POST/GET /workspaces): creating an invite needs the caller to already
// be signed in to THIS workspace (req.member/currentWorkspaceId(), set by
// resolveMember), not just any workspace — so, unlike workspacesRouter,
// this sits behind the normal, already-globally-applied resolveMember
// gate in apiRouter, not identityOnlyRouter. :id is checked against
// currentWorkspaceId() inside createInvite itself, same discipline as
// every other id-in-URL guard from the AT11 audit — a foreign workspace
// id 404s rather than silently creating an invite into it.
export const workspaceInvitesRouter = Router();

workspaceInvitesRouter.post(
  '/workspaces/:id/invites',
  asyncHandler(async (req, res) => {
    const input = createInviteSchema.parse(req.body);
    const invite = await workspacesService.createInvite(req.params.id, input);
    res.status(201).json({
      id: invite.id,
      expiresAt: invite.expiresAt,
      joinUrl: `${publicBaseUrl()}/join/${invite.token}`,
    });
  }),
);
