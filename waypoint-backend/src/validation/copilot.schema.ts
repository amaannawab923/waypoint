import { z } from 'zod';

// 8000 chars is generous for a chat message while still ruling out someone
// pasting an entire document — matches the spirit of the 5mb app-wide body
// limit in app.ts, just scoped tighter for a field that's always short text.
export const postCopilotMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000),
});

// An assistant reply can legitimately be much longer than a user's own
// message (a real streamed completion, not a short canned line) — no upper
// bound tight enough to matter without risking rejecting a real reply.
// claudeSessionId is nullable, not just optional: the Claude Code CLI stream
// always resolves to either a real session id or none (e.g. the run failed
// before ever producing a `result` event) — there's no "not provided yet"
// state once the stream has ended, which is the only time this is called.
//
// .uuid(), not just a non-empty string: this value round-trips straight back
// out to the frontend and into copilotRunner.ts's `spawn(claude, [...,
// '--resume', claudeSessionId, ...])` on every later message in the
// conversation. `--resume` takes an *optional* value, so a value starting
// with `-` (e.g. "--dangerously-skip-permissions") isn't consumed as
// `--resume`'s argument — it's parsed as its own separate flag (confirmed
// live: `claude -p --resume --help` prints help instead of erring). Real
// Claude Code session ids are always UUIDs, so this closes the same argv-
// injection class already closed for the prompt itself, at the one place
// arbitrary network-sourced text becomes untrusted CLI argv.
export const postCopilotAssistantMessageSchema = z.object({
  content: z.string().trim().min(1),
  claudeSessionId: z.string().uuid().nullable(),
});

// .strict(), not just an empty object: a stray body field on a create
// request should 400 rather than being silently ignored, matching this
// app's other create schemas. There's genuinely nothing to accept here —
// title comes from the schema's own column default, not the request.
export const createCopilotConversationSchema = z.object({}).strict();

export const renameCopilotConversationSchema = z.object({
  title: z.string().trim().min(1).max(60),
});
