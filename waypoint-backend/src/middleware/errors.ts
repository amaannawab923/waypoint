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

// ROAD-162 attachments. body-parser already throws its own
// PayloadTooLargeError with `.status: 413` and `.type: 'entity.too.large'`,
// which errorHandler.ts's trustedHttpStatus() path turns into a clean
// `request_too_large` — this class exists so the upload route can re-throw
// that same 413 carrying a message that names the actual limit, rather
// than leaving a caller to guess what "too large" meant. Named for what it
// is rather than reusing ValidationError, because a 400 would tell a
// client to fix the request shape when what they need to do is send a
// smaller file.
export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}
