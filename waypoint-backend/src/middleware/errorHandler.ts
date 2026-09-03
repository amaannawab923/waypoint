import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { NotFoundError, ConflictError, ValidationError } from './errors.js';

// The postgres-js driver throws a DrizzleQueryError wrapping the real
// PostgresError in `.cause`; the Postgres error code lives on whichever of
// the two actually carries it. Without this, a bad foreign key (e.g. a
// nonexistent projectId on create, a stateId that doesn't belong to any
// project, deleting a state that work items still reference) surfaces as an
// opaque 500 instead of a client-actionable 400/409.
function pgErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object') {
    const nested = (cause as { code?: unknown }).code;
    if (typeof nested === 'string') return nested;
  }
  return undefined;
}

// SQLSTATE class prefixes (first two chars) that genuinely mean "the server
// or its infrastructure is in trouble" — connection failures, resource
// exhaustion, operator intervention, internal errors. Everything else that
// still reaches Postgres as a recognizable SQLSTATE (constraint violations,
// data exceptions, syntax errors from a malformed `.set(patch)`, etc.) means
// the REQUEST was bad, not the server — see 23503/23505/22P02 below for the
// well-understood cases, but a whitelist-of-known-codes approach means every
// *new* code nobody has hit yet still falls through to a raw 500 (this
// happened three times: FK violations, a null-body strict-JSON rejection,
// then an empty `UPDATE ... SET` on a memberIds-only patch). Defaulting the
// rest of the SQLSTATE space to 400 closes that class of bug structurally
// instead of catching one new code at a time.
const SERVER_FAULT_SQLSTATE_CLASSES = new Set(['08', '53', '54', '55', '57', '58', 'XX']);
function isServerFaultSqlState(code: string): boolean {
  return SERVER_FAULT_SQLSTATE_CLASSES.has(code.slice(0, 2));
}

// body-parser (and other well-behaved middleware ahead of any route
// handler) throws http-errors-style objects with a `.status` already set —
// e.g. PayloadTooLargeError (`.status: 413, .type: 'entity.too.large'`) when
// a request body exceeds express.json()'s limit. These never reach a route
// handler, so they're neither a ZodError nor a Postgres error, and fell
// through to a raw 500 despite already carrying the right status. Trust a
// 4xx `.status`/`.statusCode` from a thrown error rather than re-deriving it.
function trustedHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const status = (err as { status?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'invalid_input', details: err.flatten() });
    return;
  }
  // body-parser (express.json()) throws a plain SyntaxError with a `.status`
  // of 400 for genuinely malformed JSON — map it explicitly instead of
  // falling through to a generic 500.
  if (err instanceof SyntaxError && (err as SyntaxError & { status?: number }).status === 400) {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof ValidationError) {
    // Spread rather than always-present keys: a ValidationError constructed
    // without them produces a body byte-identical to the one this branch
    // has always returned.
    res.status(400).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.path ? { path: err.path } : {}),
    });
    return;
  }
  const trustedStatus = trustedHttpStatus(err);
  if (trustedStatus) {
    const type = (err as { type?: unknown }).type;
    const error = type === 'entity.too.large' ? 'request_too_large' : 'invalid_request';
    res.status(trustedStatus).json({ error });
    return;
  }

  const code = pgErrorCode(err);
  if (code === '23503') {
    // foreign_key_violation — e.g. a project/state/label/etc id in the
    // request body or URL doesn't actually exist.
    res.status(400).json({ error: 'invalid_reference', detail: 'referenced record does not exist' });
    return;
  }
  if (code === '23505') {
    // unique_violation — e.g. duplicate email.
    res.status(409).json({ error: 'already_exists' });
    return;
  }
  if (code === '22P02') {
    // invalid_text_representation — e.g. a bad enum value.
    res.status(400).json({ error: 'invalid_input' });
    return;
  }
  if (code && /^[0-9A-Z]{5}$/.test(code) && !isServerFaultSqlState(code)) {
    // An unrecognized-but-well-formed Postgres error — still log it (so a
    // real new pattern is visible and can get its own precise handling
    // later) but don't let it crash the request as a 500.
    console.error(`Unhandled Postgres error code ${code}:`, err);
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  if (err instanceof RangeError) {
    // Defense-in-depth: the known trigger (pathologically deep JSON in
    // SavedView.filters, the one field with no fixed shape) is guarded at
    // the schema layer (see validation/shared.ts's boundedJson), but a
    // RangeError ("Maximum call stack size exceeded") reaching here at all
    // means something recursive walked attacker-controlled input — treat it
    // as a bad request, not a server fault, wherever it comes from.
    console.error('RangeError reached errorHandler (likely oversized/too-deep input):', err);
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  console.error(err);
  res.status(500).json({ error: 'internal_server_error' });
}
