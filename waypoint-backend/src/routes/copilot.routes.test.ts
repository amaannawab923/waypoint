import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';

// Mocks the service layer, not the database — these tests verify the HTTP
// contract (status codes, response shape, that validation runs before any
// service call) in isolation from copilot.service.ts's own logic, which
// copilot.service.test.ts covers separately. Builds a minimal app with just
// this router rather than importing the real createApp(), since that would
// pull in every other route module's services, which import a real db
// client that needs DATABASE_URL set just to construct.
//
// The db client mock below is not for real — nothing in this file calls it
// — it exists because vi.mock() with no factory is an automock, and an
// automock still has to *import the real module* to see what shape to fake.
// copilot.service.js imports db/client.js, which throws at import time if
// DATABASE_URL isn't set. Without this, these tests only ever passed on a
// machine with a local .env already in place — they failed outright on a
// clean clone under CI-like conditions, silently running a smaller suite
// than the file advertised.
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/copilot.service.js');
const copilotService = await import('../services/copilot.service.js');
const { copilotRouter } = await import('./copilot.routes.js');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(copilotRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /copilot/conversation', () => {
  it('returns the conversation with its messages', async () => {
    vi.mocked(copilotService.getOrCreateConversation).mockResolvedValue({
      id: 'conv-abc1234',
      memberId: 'mem-1',
      claudeSessionId: null,
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
    });
    vi.mocked(copilotService.listMessages).mockResolvedValue([
      { id: 'msg-1', conversationId: 'conv-abc1234', role: 'user', content: 'hi', seq: 1, createdAt: new Date() },
    ]);

    const res = await request(buildTestApp()).get('/copilot/conversation');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('conv-abc1234');
    expect(res.body.messages).toHaveLength(1);
    expect(copilotService.getOrCreateConversation).toHaveBeenCalledWith('mem-1');
    expect(copilotService.listMessages).toHaveBeenCalledWith('conv-abc1234');
  });
});

describe('POST /copilot/conversation/messages', () => {
  it('persists a valid message and returns 201 with the persisted user message', async () => {
    vi.mocked(copilotService.getOrCreateConversation).mockResolvedValue({
      id: 'conv-abc1234',
      memberId: 'mem-1',
      claudeSessionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(copilotService.postUserMessage).mockResolvedValue({
      id: 'msg-user1',
      conversationId: 'conv-abc1234',
      role: 'user',
      content: 'hi',
      seq: 1,
      createdAt: new Date(),
    });

    const res = await request(buildTestApp())
      .post('/copilot/conversation/messages')
      .send({ content: 'hi' });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('user');
    expect(copilotService.postUserMessage).toHaveBeenCalledWith('conv-abc1234', 'hi');
  });

  it('rejects an empty body with 400 and never calls the service', async () => {
    const res = await request(buildTestApp())
      .post('/copilot/conversation/messages')
      .send({ content: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_input');
    expect(copilotService.getOrCreateConversation).not.toHaveBeenCalled();
    expect(copilotService.postUserMessage).not.toHaveBeenCalled();
  });

  it('rejects a missing content field with 400', async () => {
    const res = await request(buildTestApp()).post('/copilot/conversation/messages').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_input');
  });

  it('rejects content over the length limit with 400', async () => {
    const res = await request(buildTestApp())
      .post('/copilot/conversation/messages')
      .send({ content: 'a'.repeat(8001) });

    expect(res.status).toBe(400);
  });
});

describe('POST /copilot/conversation/messages/assistant', () => {
  it('persists the reply and the claudeSessionId, returns 201 with the persisted assistant message', async () => {
    vi.mocked(copilotService.getOrCreateConversation).mockResolvedValue({
      id: 'conv-abc1234',
      memberId: 'mem-1',
      claudeSessionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(copilotService.postAssistantMessage).mockResolvedValue({
      id: 'msg-reply1',
      conversationId: 'conv-abc1234',
      role: 'assistant',
      content: 'here is my answer',
      seq: 2,
      createdAt: new Date(),
    });

    const res = await request(buildTestApp())
      .post('/copilot/conversation/messages/assistant')
      .send({ content: 'here is my answer', claudeSessionId: '6b16ad5b-1e3f-4a2c-8f9d-2c7e5a9b3d10' });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('assistant');
    expect(copilotService.postAssistantMessage).toHaveBeenCalledWith(
      'conv-abc1234',
      'here is my answer',
      '6b16ad5b-1e3f-4a2c-8f9d-2c7e5a9b3d10',
    );
  });

  // Real Claude Code session ids are always UUIDs — this value round-trips
  // straight into copilotRunner.ts's `spawn(claude, [..., '--resume',
  // claudeSessionId, ...])` on the frontend, so a non-UUID string (most
  // importantly one starting with `-`, which `--resume`'s optional-value
  // parsing would otherwise treat as a separate flag rather than its
  // argument) must never reach the database in the first place.
  it('rejects a non-UUID claudeSessionId with 400 and never calls the service', async () => {
    const res = await request(buildTestApp())
      .post('/copilot/conversation/messages/assistant')
      .send({ content: 'reply', claudeSessionId: '--dangerously-skip-permissions' });

    expect(res.status).toBe(400);
    expect(copilotService.postAssistantMessage).not.toHaveBeenCalled();
  });

  it('accepts an explicit null claudeSessionId', async () => {
    vi.mocked(copilotService.getOrCreateConversation).mockResolvedValue({
      id: 'conv-abc1234',
      memberId: 'mem-1',
      claudeSessionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(copilotService.postAssistantMessage).mockResolvedValue({
      id: 'msg-reply1',
      conversationId: 'conv-abc1234',
      role: 'assistant',
      content: 'reply',
      seq: 2,
      createdAt: new Date(),
    });

    const res = await request(buildTestApp())
      .post('/copilot/conversation/messages/assistant')
      .send({ content: 'reply', claudeSessionId: null });

    expect(res.status).toBe(201);
    expect(copilotService.postAssistantMessage).toHaveBeenCalledWith('conv-abc1234', 'reply', null);
  });

  it('rejects a missing claudeSessionId field with 400 and never calls the service', async () => {
    const res = await request(buildTestApp())
      .post('/copilot/conversation/messages/assistant')
      .send({ content: 'reply' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_input');
    expect(copilotService.postAssistantMessage).not.toHaveBeenCalled();
  });

  it('rejects empty content with 400', async () => {
    const res = await request(buildTestApp())
      .post('/copilot/conversation/messages/assistant')
      .send({ content: '', claudeSessionId: null });

    expect(res.status).toBe(400);
  });
});
