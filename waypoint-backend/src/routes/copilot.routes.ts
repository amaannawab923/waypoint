import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';
import * as copilotService from '../services/copilot.service.js';
import {
  postCopilotMessageSchema,
  postCopilotAssistantMessageSchema,
  createCopilotConversationSchema,
  renameCopilotConversationSchema,
} from '../validation/copilot.schema.js';

export const copilotRouter = Router();

copilotRouter.get(
  '/copilot/conversations',
  asyncHandler(async (_req, res) => {
    res.json(await copilotService.listConversations(CURRENT_USER_ID));
  }),
);

copilotRouter.post(
  '/copilot/conversations',
  asyncHandler(async (req, res) => {
    createCopilotConversationSchema.parse(req.body ?? {});
    const conversation = await copilotService.createConversation(CURRENT_USER_ID);
    res.status(201).json(conversation);
  }),
);

copilotRouter.get(
  '/copilot/conversations/:id',
  asyncHandler(async (req, res) => {
    const conversation = await copilotService.getConversation(req.params.id);
    const messages = await copilotService.listMessages(conversation.id);
    res.json({ ...conversation, messages });
  }),
);

copilotRouter.patch(
  '/copilot/conversations/:id',
  asyncHandler(async (req, res) => {
    const { title } = renameCopilotConversationSchema.parse(req.body);
    res.json(await copilotService.renameConversation(req.params.id, title));
  }),
);

copilotRouter.delete(
  '/copilot/conversations/:id',
  asyncHandler(async (req, res) => {
    await copilotService.deleteConversation(req.params.id);
    res.status(204).end();
  }),
);

copilotRouter.post(
  '/copilot/conversations/:id/messages',
  asyncHandler(async (req, res) => {
    const { content } = postCopilotMessageSchema.parse(req.body);
    const message = await copilotService.postUserMessage(req.params.id, content);
    res.status(201).json(message);
  }),
);

// A separate route, not a PATCH against the user message's id: there's no
// client-known id to PATCH against until this call itself creates one. The
// caller (Electron's main process, via the renderer) invokes this once a
// Claude Code CLI stream has fully completed — see issue #7.
copilotRouter.post(
  '/copilot/conversations/:id/messages/assistant',
  asyncHandler(async (req, res) => {
    const { content, claudeSessionId } = postCopilotAssistantMessageSchema.parse(req.body);
    const message = await copilotService.postAssistantMessage(req.params.id, content, claudeSessionId);
    res.status(201).json(message);
  }),
);
