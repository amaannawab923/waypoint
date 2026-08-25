import { z } from 'zod';

// 8000 chars is generous for a chat message while still ruling out someone
// pasting an entire document — matches the spirit of the 5mb app-wide body
// limit in app.ts, just scoped tighter for a field that's always short text.
export const postCopilotMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000),
});
