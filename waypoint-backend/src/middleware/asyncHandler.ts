import type { Request, Response, NextFunction, RequestHandler } from 'express';

// Express 4 doesn't catch rejected promises from async handlers on its own —
// every route handler in this project is async, so this wrapper is what
// routes async errors into errorHandler.ts instead of hanging the request.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
