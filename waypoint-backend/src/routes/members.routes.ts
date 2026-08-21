import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as membersService from '../services/members.service.js';
import { inviteMemberSchema, updateCurrentUserSchema } from '../validation/workspace.schema.js';

export const membersRouter = Router();

membersRouter.get(
  '/me',
  asyncHandler(async (_req, res) => {
    res.json(await membersService.getCurrentUser());
  }),
);

membersRouter.patch(
  '/me',
  asyncHandler(async (req, res) => {
    const patch = updateCurrentUserSchema.parse(req.body);
    res.json(await membersService.updateCurrentUser(patch));
  }),
);

membersRouter.get(
  '/members',
  asyncHandler(async (_req, res) => {
    res.json(await membersService.listMembers());
  }),
);

membersRouter.post(
  '/members',
  asyncHandler(async (req, res) => {
    const input = inviteMemberSchema.parse(req.body);
    res.status(201).json(await membersService.inviteMember(input));
  }),
);
