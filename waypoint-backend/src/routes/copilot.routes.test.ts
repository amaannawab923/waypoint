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
  it('persists a valid message and returns 201 with the reply', async () => {
    vi.mocked(copilotService.getOrCreateConversation).mockResolvedValue({
      id: 'conv-abc1234',
      memberId: 'mem-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    vi.mocked(copilotService.postMessage).mockResolvedValue({
      id: 'msg-reply1',
      conversationId: 'conv-abc1234',
      role: 'assistant',
      content: 'canned reply',
      seq: 2,
      createdAt: new Date(),
    });

    const res = await request(buildTestApp())
      .post('/copilot/conversation/messages')
      .send({ content: 'hi' });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('assistant');
    expect(copilotService.postMessage).toHaveBeenCalledWith('conv-abc1234', 'hi');
  });

  it('rejects an empty body with 400 and never calls the service', async () => {
    const res = await request(buildTestApp())
      .post('/copilot/conversation/messages')
      .send({ content: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_input');
    expect(copilotService.getOrCreateConversation).not.toHaveBeenCalled();
    expect(copilotService.postMessage).not.toHaveBeenCalled();
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
