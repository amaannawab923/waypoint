import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';

// AT8 (ROAD-143): the HTTP contract. What maps to which status — the
// setup token's three outcomes, the admin guard's two, validation — with
// the service mocked. The transaction itself is proven in
// instance.service.integration.test.ts against real Postgres.
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../services/instance.service.js');
// AT12 (ROAD-147): admin.routes.ts now sits behind requireUser, which
// resolves a real bearer token via auth/sessions.js's resolveSession —
// mocked here rather than injecting req.user directly, since that's the
// actual dependency the route now has.
vi.mock('../auth/sessions.js');

const service = await import('../services/instance.service.js');
const sessions = await import('../auth/sessions.js');
const { instanceRouter } = await import('./instance.routes.js');
const { adminRouter } = await import('./admin.routes.js');
const { requireInstanceAdmin } = await import('../middleware/auth.js');

const ADMIN = {
  id: 'user-admin',
  email: 'op@example.test',
  authMethod: 'email' as const,
  emailVerifiedAt: null,
  authProviderId: null,
  fullName: 'Op',
  avatarUrl: null,
  isInstanceAdmin: true,
  createdAt: new Date(),
};

// AT12 (ROAD-147): when `user` is given, resolveSession resolves the
// literal 'Bearer test-token' to it — callers set that header, the same
// bearer-token shape requireUser actually depends on now.
function app(user?: typeof ADMIN) {
  vi.mocked(sessions.resolveSession).mockImplementation(async (token) =>
    user && token === 'test-token'
      ? { user, session: { id: 'sess-1', userId: user.id, tokenHash: 'x', createdAt: new Date(), expiresAt: new Date(), lastSeenAt: null, deviceLabel: null } }
      : null,
  );
  vi.mocked(sessions.touchSession).mockResolvedValue(undefined);
  const a = express();
  a.use(express.json());
  a.use(instanceRouter);
  a.use(adminRouter);
  a.use(errorHandler);
  return a;
}

const SETUP_BODY = {
  instanceName: 'Fairweather',
  signupMode: 'invite_only',
  admin: { email: 'op@example.test', fullName: 'Op' },
};

const envBackup = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  process.env = { ...envBackup };
});

describe('GET /instance/setup-status', () => {
  it('is public and passes the service result through', async () => {
    vi.mocked(service.getSetupStatus).mockResolvedValue({
      setupRequired: true,
      instanceName: null,
      authMethods: ['github'],
      signupMode: null,
    });
    const res = await request(app()).get('/instance/setup-status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ setupRequired: true, instanceName: null, authMethods: ['github'], signupMode: null });
  });
});

describe('POST /instance/setup', () => {
  it('503s when no setup token is configured — a config state, not a client error', async () => {
    delete process.env.INSTANCE_SETUP_TOKEN;
    const res = await request(app()).post('/instance/setup').send(SETUP_BODY);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/INSTANCE_SETUP_TOKEN/);
    expect(service.completeSetup).not.toHaveBeenCalled();
  });

  it('401s on a missing or wrong bearer token', async () => {
    process.env.INSTANCE_SETUP_TOKEN = 'correct-horse';
    expect((await request(app()).post('/instance/setup').send(SETUP_BODY)).status).toBe(401);
    expect(
      (await request(app()).post('/instance/setup').set('Authorization', 'Bearer wrong').send(SETUP_BODY)).status,
    ).toBe(401);
    expect(
      (await request(app()).post('/instance/setup').set('Authorization', 'Basic correct-horse').send(SETUP_BODY)).status,
    ).toBe(401);
    expect(service.completeSetup).not.toHaveBeenCalled();
  });

  it('400s invalid input before touching the service', async () => {
    process.env.INSTANCE_SETUP_TOKEN = 'correct-horse';
    const res = await request(app())
      .post('/instance/setup')
      .set('Authorization', 'Bearer correct-horse')
      .send({ ...SETUP_BODY, signupMode: 'anyone' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_input');
    expect(service.completeSetup).not.toHaveBeenCalled();
  });

  it('201s with the instance and admin on a correct token', async () => {
    process.env.INSTANCE_SETUP_TOKEN = 'correct-horse';
    vi.mocked(service.completeSetup).mockResolvedValue({ instance: { id: 'instance' }, admin: ADMIN } as never);
    const res = await request(app())
      .post('/instance/setup')
      .set('Authorization', 'Bearer correct-horse')
      .send(SETUP_BODY);
    expect(res.status).toBe(201);
    expect(service.completeSetup).toHaveBeenCalledWith(SETUP_BODY);
    expect(res.body.admin.isInstanceAdmin).toBe(true);
  });

  it('maps an already-set-up instance to 409', async () => {
    process.env.INSTANCE_SETUP_TOKEN = 'correct-horse';
    const { ConflictError } = await import('../middleware/errors.js');
    vi.mocked(service.completeSetup).mockRejectedValue(new ConflictError('already'));
    const res = await request(app())
      .post('/instance/setup')
      .set('Authorization', 'Bearer correct-horse')
      .send(SETUP_BODY);
    expect(res.status).toBe(409);
  });
});

describe('/admin/instance', () => {
  it('401s with no bearer token at all', async () => {
    expect((await request(app()).get('/admin/instance')).status).toBe(401);
    expect((await request(app()).patch('/admin/instance').send({ signupMode: 'open' })).status).toBe(401);
    expect(service.getInstance).not.toHaveBeenCalled();
    expect(service.updateInstance).not.toHaveBeenCalled();
  });

  it('403s a signed-in non-admin', async () => {
    const res = await request(app({ ...ADMIN, isInstanceAdmin: false }))
      .get('/admin/instance')
      .set('Authorization', 'Bearer test-token');
    expect(res.status).toBe(403);
    expect(service.getInstance).not.toHaveBeenCalled();
  });

  it('serves and patches for an instance admin', async () => {
    vi.mocked(service.getInstance).mockResolvedValue({ id: 'instance', counts: { workspaces: 1, users: 1 } } as never);
    vi.mocked(service.updateInstance).mockResolvedValue({ id: 'instance', signupMode: 'open' } as never);
    const app_ = app(ADMIN);
    const get = await request(app_).get('/admin/instance').set('Authorization', 'Bearer test-token');
    expect(get.status).toBe(200);
    expect(get.body.counts).toEqual({ workspaces: 1, users: 1 });
    const patch = await request(app_)
      .patch('/admin/instance')
      .set('Authorization', 'Bearer test-token')
      .send({ signupMode: 'open' });
    expect(patch.status).toBe(200);
    expect(service.updateInstance).toHaveBeenCalledWith({ signupMode: 'open' });
  });

  it('400s an empty patch', async () => {
    const res = await request(app(ADMIN))
      .patch('/admin/instance')
      .set('Authorization', 'Bearer test-token')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('requireInstanceAdmin', () => {
  it('is the guard the routes use, not a copy', () => {
    // Guards against a future route silently dropping the middleware.
    const stack = (adminRouter as unknown as { stack: Array<{ route?: { stack: Array<{ handle: unknown }> } }> }).stack;
    for (const layer of stack) {
      if (!layer.route) continue;
      expect(layer.route.stack.some((l) => l.handle === requireInstanceAdmin)).toBe(true);
    }
  });
});
