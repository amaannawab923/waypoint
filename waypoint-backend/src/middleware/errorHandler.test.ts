import type { Request, Response, NextFunction } from 'express';
import { describe, it, expect, vi } from 'vitest';
import { errorHandler } from './errorHandler.js';
import { NotFoundError, ConflictError, ValidationError } from './errors.js';

function fakeRes() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { status, json } as unknown as Response, status, json };
}

function handle(err: unknown) {
  const { res, status, json } = fakeRes();
  errorHandler(err, {} as Request, res, (() => {}) as NextFunction);
  return { status, json };
}

describe('errorHandler', () => {
  // Added with Copilot V3's repoPath check: a domain rule that needs `fs`
  // can't be a ZodError, and without this branch it fell through to a raw
  // 500 with the real reason ("not a git repository") swallowed.
  it('maps a ValidationError to 400 with its own message', () => {
    const { status, json } = handle(new ValidationError('repoPath is not a git repository: /tmp/x'));

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'repoPath is not a git repository: /tmp/x' });
  });

  it('still maps NotFoundError to 404 and ConflictError to 409', () => {
    expect(handle(new NotFoundError('project')).status).toHaveBeenCalledWith(404);
    expect(handle(new ConflictError('already exists')).status).toHaveBeenCalledWith(409);
  });

  it('falls back to 500 for an unrecognized error', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { status, json } = handle(new Error('something unexpected'));

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: 'internal_server_error' });
    consoleError.mockRestore();
  });
});
