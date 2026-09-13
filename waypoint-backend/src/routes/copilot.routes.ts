import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { CURRENT_USER_ID } from '../lib/currentUser.js';
import { NotFoundError } from '../middleware/errors.js';
import * as copilotService from '../services/copilot.service.js';
import {
  postCopilotMessageSchema,
  postCopilotAssistantMessageSchema,
  createCopilotConversationSchema,
  renameCopilotConversationSchema,
  postCopilotNoteSchema,
  markCopilotNotesDeliveredSchema,
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

// W5a (ROAD-117): system notes. `POST /copilot/notes` is main's — a run
// finished, its proposals were decided — and picks the conversation the
// run came from, else the member's latest; no conversation at all is a
// 204, not an error (the panel badge and Review still carry the news).
copilotRouter.post(
  '/copilot/notes',
  asyncHandler(async (req, res) => {
    const { runId, conversationId, content } = postCopilotNoteSchema.parse(req.body);
    const target =
      conversationId ?? (await copilotService.resolveNoteConversation(CURRENT_USER_ID, runId ?? null));
    if (!target) {
      res.status(204).end();
      return;
    }
    try {
      res.status(201).json(await copilotService.postSystemNote(target, content));
    } catch (error) {
      if (error instanceof NotFoundError) {
        res.status(204).end();
        return;
      }
      throw error;
    }
  }),
);

copilotRouter.post(
  '/copilot/conversations/:id/notes/delivered',
  asyncHandler(async (req, res) => {
    const { ids } = markCopilotNotesDeliveredSchema.parse(req.body);
    res.json(await copilotService.markNotesDelivered(req.params.id, ids));
  }),
);
