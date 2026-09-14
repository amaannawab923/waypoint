import { z } from 'zod';
import { requireAtLeastOneField } from './shared.js';

// AT8 (ROAD-143). The two literals are the ones instance_settings stores
// and INSTANCE_SIGNUP_MODE (spec §8) accepts — one spelling everywhere.
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
