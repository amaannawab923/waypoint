import { z } from 'zod';

export const createStickySchema = z.object({
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
      'work_item.created',
      'work_item.updated',
      'work_item.deleted',
      'project.created',
      'cycle.created',
      'module.created',
    ]),
  ),
});
