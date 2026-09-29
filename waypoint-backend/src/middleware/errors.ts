export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

// ROAD-162: there is no role-based authz layer in this backend (verified —
// one `role !==` check exists, in the invite flow, workspaces.service.ts).
// Author-only comment edit/delete is enforced in the service, against
// currentMemberId(), and throws this rather than reusing NotFoundError:
// unlike a cross-workspace id (which must 404 to avoid disclosing existence
// — see workspaceGuard.ts), the caller here already has the comment in
// front of them (it came from listComments on a ticket they can see), so
// hiding that it exists would be dishonest, not a safety improvement.
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

// For domain rules zod can't express because they need I/O against the
// machine this process runs on (e.g. "this path is a real git checkout") —
// still a bad request, so errorHandler maps it to 400 like a ZodError.
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// For "this instance isn't configured to do that" — an operator state, not
// a client mistake (AT8: INSTANCE_SETUP_TOKEN unset). 503, so a client can
// tell "try again once the operator fixes it" from a 4xx it caused.
export class ServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
  }
}
