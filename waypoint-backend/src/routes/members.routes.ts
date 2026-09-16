import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as membersService from '../services/members.service.js';
import * as memberCredentialsService from '../services/memberCredentials.service.js';
import { inviteMemberSchema, updateCurrentUserSchema, setJiraCredentialSchema } from '../validation/workspace.schema.js';

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

// AT12 (ROAD-147). Self-service only, by construction — every function in
// memberCredentials.service.ts reads currentMemberId() and nothing else,
// so there's no id param here for a cross-tenant guard to even be about.
// Never returns the raw apiToken back to the client, on GET or PUT.
membersRouter.get(
  '/me/jira-credential',
  asyncHandler(async (_req, res) => {
    res.json(await memberCredentialsService.getMyJiraCredentialStatus());
  }),
);

membersRouter.put(
  '/me/jira-credential',
  asyncHandler(async (req, res) => {
    const input = setJiraCredentialSchema.parse(req.body);
    res.json(await memberCredentialsService.setMyJiraCredential(input));
  }),
);

membersRouter.delete(
  '/me/jira-credential',
  asyncHandler(async (_req, res) => {
    await memberCredentialsService.clearMyJiraCredential();
    res.status(204).end();
  }),
);
