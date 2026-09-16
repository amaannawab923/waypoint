import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireUser } from '../middleware/auth.js';
import * as workspacesService from '../services/workspaces.service.js';
import { createWorkspaceSchema } from '../validation/workspace.schema.js';

// AT12 (ROAD-147). The workspace COLLECTION — creating one, listing every
// one the signed-in user belongs to (spec §7 steps 6/11). Distinct from
// workspace.routes.ts's singular GET/PATCH /workspace, which only ever
// reads/writes the caller's current workspace and sits behind the normal
// resolveMember gate. Both routes here sit behind requireUser instead —
// see middleware/auth.ts's own comment on why resolveMember can't be used
// for a route that runs before any single workspace is the caller's
// context. Mounted in routes/index.ts's identityOnlyRouter, BEFORE
// resolveMember — see that file's comment.
export const workspacesRouter = Router();

workspacesRouter.post(
  '/workspaces',
  asyncHandler(requireUser),
  asyncHandler(async (req, res) => {
    const input = createWorkspaceSchema.parse(req.body);
    const { workspace, member } = await workspacesService.createWorkspace(input, req.user!);
    res.status(201).json({ ...workspace, myMemberId: member.id, myRole: member.role });
  }),
);

workspacesRouter.get(
  '/workspaces',
  asyncHandler(requireUser),
  asyncHandler(async (req, res) => {
    res.json(await workspacesService.listMyWorkspaces(req.user!.id));
  }),
);
