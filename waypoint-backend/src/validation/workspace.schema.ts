import { z } from 'zod';
import { requireAtLeastOneField } from './shared.js';

export const updateWorkspaceSchema = requireAtLeastOneField(
  z.object({
    name: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    companySize: z.string().optional(),
    timezone: z.string().optional(),
    plan: z.enum(['community', 'pro', 'business', 'enterprise']).optional(),
    restrictWorkspaceCreation: z.boolean().optional(),
    // A provider id as the engine names them ('claude', 'codex'); which
    // ids Waypoint can actually start is main's SUPPORTED_PROVIDERS, not
    // this schema's — the backend stores the preference.
    defaultAgentProvider: z.string().min(1).max(64).nullable().optional(),
  }),
);

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member', 'guest']),
});

// AT12 (ROAD-147).
export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(120),
});

export const createInviteSchema = z.object({
  // Only "Email invite instead" (mockup step 9) collects one; plain "Copy
  // link" creates an invite with no address attached at all.
  email: z.string().email().optional(),
});

// AT12 (ROAD-147). site's real shape check is normalizeSite() in
// memberCredentials.service.ts (a bare hostname check needs URL parsing,
// not a regex); this only rejects the empty/missing case up front.
export const setJiraCredentialSchema = z.object({
  site: z.string().min(1),
  email: z.string().email(),
  apiToken: z.string().min(1),
});

export const notificationPrefsSchema = z.object({
  email: z.boolean().optional(),
  push: z.boolean().optional(),
  mentions: z.boolean().optional(),
  comments: z.boolean().optional(),
});

export const updateCurrentUserSchema = requireAtLeastOneField(
  z.object({
    fullName: z.string().min(1).optional(),
    displayName: z.string().min(1).optional(),
    email: z.string().email().optional(),
    firstDayOfWeek: z.enum(['Sunday', 'Monday']).optional(),
    // Merged into the stored value, not replaced — see
    // members.service.ts's updateCurrentUser, the same convention
    // projects.service.ts's updateProjectAutomations uses for its own
    // partial-patch jsonb column.
    notificationPrefs: notificationPrefsSchema.optional(),
  }),
);
