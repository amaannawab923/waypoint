import { z } from 'zod';

export const createScratchNoteSchema = z.object({
  title: z.string(),
  body: z.string(),
});

export const createExportSchema = z.object({
  scopeLabel: z.string(),
  format: z.string(),
});

export const createWebhookSchema = z.object({
  // .url() alone is scheme-agnostic — file://, javascript:, ftp:// all pass.
  // A webhook is meant to receive an HTTP POST; restrict to http(s) now so
  // a bad target can't get stored as "valid" before delivery ever ships.
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
      message: 'must be an http:// or https:// URL',
    }),
  eventTypes: z.array(
    z.enum([
      'ticket.created',
      'ticket.updated',
      'ticket.deleted',
      'project.created',
      'sprint.created',
      'workstream.created',
    ]),
  ),
});
