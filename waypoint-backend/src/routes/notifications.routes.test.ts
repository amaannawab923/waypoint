import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';

// HTTP contract only, same shape as reviewQueue.routes.test.ts: mocked
// service layer, validation must run before any service call.
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/notifications.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/notifications.service.js')>();
  return {
    ...real,
    listNotifications: vi.fn(),
    countUnreadNotifications: vi.fn(),
    markNotificationRead: vi.fn(),
    markNotificationUnread: vi.fn(),
    markAllNotificationsRead: vi.fn(),
  };
});
const svc = await import('../services/notifications.service.js');
const { notificationsRouter } = await import('./notifications.routes.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use(notificationsRouter);
  a.use(errorHandler);
  return a;
}

beforeEach(() => vi.clearAllMocks());

describe('GET /notifications', () => {
  it('passes tab, unread, limit and cursor through', async () => {
    vi.mocked(svc.listNotifications).mockResolvedValue({ items: [], nextCursor: null, unreadCount: 0 });
    const res = await request(app()).get('/notifications?tab=mentions&unread=true&limit=20&cursor=abc');
    expect(res.status).toBe(200);
    expect(svc.listNotifications).toHaveBeenCalledWith({ tab: 'mentions', unreadOnly: true, limit: 20, cursor: 'abc' });
  });

  it.each([
    ['an unknown tab', '?tab=everything'],
    ['an unknown key', '?page=2'],
    ['a limit past the cap', '?limit=500'],
    ['a non-boolean unread', '?unread=yes'],
  ])('rejects %s with a 400 before touching the service', async (_l, qs) => {
    const res = await request(app()).get(`/notifications${qs}`);
    expect(res.status).toBe(400);
    expect(svc.listNotifications).not.toHaveBeenCalled();
  });
});

describe('the rest of the surface', () => {
  it('serves the unread count at its own path, not as an id', async () => {
    vi.mocked(svc.countUnreadNotifications).mockResolvedValue(3);
    const res = await request(app()).get('/notifications/unread-count');
    expect(res.body).toEqual({ count: 3 });
  });

  it('marks one read and one unread', async () => {
    expect((await request(app()).post('/notifications/nt-1/read')).status).toBe(204);
    expect(svc.markNotificationRead).toHaveBeenCalledWith('nt-1');
    expect((await request(app()).post('/notifications/nt-1/unread')).status).toBe(204);
    expect(svc.markNotificationUnread).toHaveBeenCalledWith('nt-1');
  });

  it('read-all requires a `before` bound', async () => {
    const res = await request(app()).post('/notifications/read-all').send({ tab: 'all' });
    expect(res.status).toBe(400);
    expect(svc.markAllNotificationsRead).not.toHaveBeenCalled();
  });

  it('read-all passes the bound and tab through and returns the count', async () => {
    vi.mocked(svc.markAllNotificationsRead).mockResolvedValue({ updated: 4 });
    const res = await request(app()).post('/notifications/read-all').send({ tab: 'mentions', before: 'cur' });
    expect(res.body).toEqual({ updated: 4 });
    expect(svc.markAllNotificationsRead).toHaveBeenCalledWith({ tab: 'mentions', before: 'cur' });
  });
});
