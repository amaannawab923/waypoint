import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireInstanceAdmin, requireUser } from '../middleware/auth.js';
import * as instanceService from '../services/instance.service.js';
import { updateInstanceSchema } from '../validation/instance.schema.js';

// AT8 (ROAD-143). The instance-level admin surface a self-hoster uses
// (spec §4, "God Mode"). Every route here sits behind requireInstanceAdmin,
// which reads req.user.
//
// AT12 (ROAD-147) fix: req.user used to come only from resolveMember.ts's
// global middleware — which never sets it unless a workspace header ALSO
// resolves to a real membership. An instance admin isn't necessarily a
// member of any particular workspace, so this route was unreachable (401)
// for exactly the person it's for. requireUser resolves req.user from the
// bearer token alone, same as every other route here needs.
export const adminRouter = Router();
adminRouter.get(
  '/admin/instance',
  asyncHandler(requireUser),
  requireInstanceAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await instanceService.getInstance());
  }),
);

adminRouter.patch(
  '/admin/instance',
  asyncHandler(requireUser),
  requireInstanceAdmin,
  asyncHandler(async (req, res) => {
    const patch = updateInstanceSchema.parse(req.body);
    res.json(await instanceService.updateInstance(patch));
  }),
);
