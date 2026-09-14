import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireInstanceAdmin } from '../middleware/auth.js';
import * as instanceService from '../services/instance.service.js';
import { updateInstanceSchema } from '../validation/instance.schema.js';

// AT8 (ROAD-143). The instance-level admin surface a self-hoster uses
// (spec §4, "God Mode"). Every route here sits behind requireInstanceAdmin,
// which reads req.user — attached by AT11's session middleware, so until
// that lands these answer 401. Cloud runs the same code; nobody outside
// our own ops holds isInstanceAdmin there.
export const adminRouter = Router();
adminRouter.get(
  '/admin/instance',
  requireInstanceAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await instanceService.getInstance());
  }),
);

adminRouter.patch(
  '/admin/instance',
  requireInstanceAdmin,
  asyncHandler(async (req, res) => {
    const patch = updateInstanceSchema.parse(req.body);
    res.json(await instanceService.updateInstance(patch));
  }),
);
