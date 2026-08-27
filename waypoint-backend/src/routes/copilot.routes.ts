import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';
import * as copilotService from '../services/copilot.service.js';
import { postCopilotMessageSchema, postCopilotAssistantMessageSchema } from '../validation/copilot.schema.js';

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
    const message = await copilotService.postUserMessage(conversation.id, content);
    res.status(201).json(message);
  }),
);

// A separate route, not a PATCH against the user message's id: there's no
// client-known id to PATCH against until this call itself creates one. The
// caller (Electron's main process, via the renderer) invokes this once a
// Claude Code CLI stream has fully completed — see issue #7.
copilotRouter.post(
  '/copilot/conversation/messages/assistant',
  asyncHandler(async (req, res) => {
    const { content, claudeSessionId } = postCopilotAssistantMessageSchema.parse(req.body);
    const conversation = await copilotService.getOrCreateConversation(CURRENT_USER_ID);
    const message = await copilotService.postAssistantMessage(conversation.id, content, claudeSessionId);
    res.status(201).json(message);
  }),
);
