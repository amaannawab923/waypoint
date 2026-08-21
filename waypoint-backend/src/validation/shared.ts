import { z } from 'zod';

const MAX_JSON_DEPTH = 8;

// Iterative, not recursive — a recursive depth-checker would itself
// stack-overflow on the exact pathological deeply-nested input it's meant
// to reject (that's the bug this guards against: a small-in-bytes but
// thousands-deep object crashing the process with a RangeError that no
// error-handler branch recognizes, since it's not a ZodError, Postgres
// error, or trusted HTTP status — it never gets that far).
function exceedsMaxDepth(root: unknown, maxDepth: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > maxDepth) return true;
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) {
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return false;
}

// Applied to the one field in the whole API that accepts arbitrary-shape
// JSON (SavedView.filters) — everything else has an explicit zod shape, so
// depth is already implicitly bounded by the schema itself.
export function boundedJson<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((value, ctx) => {
    if (exceedsMaxDepth(value, MAX_JSON_DEPTH)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `nested more than ${MAX_JSON_DEPTH} levels deep` });
    }
  });
}

// Wraps an all-optional-fields PATCH schema so an empty `{}` body is
// rejected as 400 invalid_input at the validation boundary, rather than
// reaching a service's `.update().set(patch)` as an empty object — which
// Postgres rejects with a syntax error that surfaces as a raw 500 (see
// cycles.service.ts/modules.service.ts's memberIds-only patch bug, and the
// same underlying risk in every other all-optional PATCH schema).
export function requireAtLeastOneField<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.refine((obj) => Object.keys(obj).length > 0, {
    message: 'at least one field is required',
  });
}
