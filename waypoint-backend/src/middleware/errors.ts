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
