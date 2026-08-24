import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';
import * as copilotService from '../services/copilot.service.js';
import { postCopilotMessageSchema } from '../validation/copilot.schema.js';

export const copilotRouter = Router();

copilotRouter.get(
  '/copilot/conversation',
  asyncHandler(async (_req, res) => {
    const conversation = await copilotService.getOrCreateConversation(CURRENT_USER_ID);
    const messages = await copilotService.listMessages(conversation.id);
    res.json({ ...conversation, messages });
  }),
);

copilotRouter.post(
  '/copilot/conversation/messages',
  asyncHandler(async (req, res) => {
    const { content } = postCopilotMessageSchema.parse(req.body);
    const conversation = await copilotService.getOrCreateConversation(CURRENT_USER_ID);
    const reply = await copilotService.postMessage(conversation.id, content);
    res.status(201).json(reply);
  }),
);
