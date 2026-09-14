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
