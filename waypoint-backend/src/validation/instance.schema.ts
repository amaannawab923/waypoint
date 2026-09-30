import { z } from 'zod';
import { requireAtLeastOneField } from './shared.js';

// AT8 (ROAD-143). The two literals are the ones instance_settings
// stores — one spelling everywhere. Spec §8 named an INSTANCE_SIGNUP_MODE
// env var; AT13 (ROAD-148) found it was never actually implemented (see
// docs/operations/self-hosted-setup.md) — signupMode is set via
// POST /instance/setup and changed via PATCH /admin/instance instead.
export const signupModeSchema = z.enum(['open', 'invite_only']);

export const completeSetupSchema = z.object({
  instanceName: z.string().trim().min(1).max(80),
  signupMode: signupModeSchema,
  admin: z.object({
    email: z.string().trim().email(),
    fullName: z.string().trim().min(1).max(120),
  }),
});

export const updateInstanceSchema = requireAtLeastOneField(
  z.object({
    instanceName: z.string().trim().min(1).max(80).optional(),
    signupMode: signupModeSchema.optional(),
  }),
);
