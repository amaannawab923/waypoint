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
//
// `code` and `path` are optional and additive: a client that wants to render
// its own copy for a specific failure (the repo-link UI does) keys off the
// stable code rather than string-matching `message`, whose whole purpose is
// being human-readable and therefore free to be reworded. Callers that pass
// neither produce exactly the response body they always did.
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}
