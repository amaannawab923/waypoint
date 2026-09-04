/**
 * Every surface that promises something must have an entry here, and every
 * entry that is not 'shipped' must render <NotWired/> where the promise is.
 * Adding a surface without an entry is a review failure. This file is the
 * answer to "is anything in the product lying right now?" — one file read.
 *
 * See docs/design/waypoint-revamp-architecture.md §7.1.
 */
export type CapabilityState = 'shipped' | 'partial' | 'not-wired';

export interface Capability {
  state: CapabilityState;
  /** What the user sees where the promise used to be. Required unless shipped. */
  note?: string;
  /** Where the gap is, so the next person can find it. */
  ref?: string;
}

export const CAPABILITIES = {
  'webhooks.delivery': {
    state: 'not-wired',
    note: 'Webhooks are saved but nothing is delivered yet.',
    ref: 'services/webhooks.service.ts has no dispatch',
  },
  'exports.download': {
    state: 'not-wired',
    note: 'Exports are recorded but no file is produced yet.',
    ref: 'exports.service.ts inserts status:completed and returns',
  },
  'automations.autoArchive': {
    state: 'not-wired',
    note: 'This setting is saved but nothing acts on it yet.',
  },
  'automations.autoClose': {
    state: 'not-wired',
    note: 'This setting is saved but nothing acts on it yet.',
  },
  'profile.notificationPrefs': {
    state: 'not-wired',
    note: 'These preferences are saved but nothing sends notifications yet.',
  },
  'preferences.firstDayOfWeek': {
    state: 'not-wired',
    note: 'The calendar currently always starts on Monday.',
  },
  'requests.publicForm': {
    state: 'not-wired',
    note: 'The public submission form is not published yet.',
  },
  'sprints.burndown': {
    state: 'partial',
    note: 'Two measured points — today and the sprint start. No daily history is recorded yet.',
  },
  'tickets.drafts': {
    state: 'not-wired',
    note: 'Nothing saves a draft yet, so this list cannot fill.',
  },
  'agents.runtime': {
    state: 'not-wired',
    note: 'This agent is configured but not yet running. Assignments will queue.',
  },
  'scratchpad.editing': {
    state: 'partial',
    note: 'There is no update endpoint yet — saving an edit deletes and recreates this note, and its color reassigns at random.',
    ref: 'scratchNotes.service.ts has no update, only create/delete',
  },
  'members.guestAccess': {
    state: 'not-wired',
    note: 'This setting is saved but nothing restricts project access based on it yet.',
    ref: 'no code path reads project.guestAccessEnabled to gate access',
  },
  'members.invite': {
    state: 'not-wired',
    note: 'No invite email is sent — adding someone here grants them full access immediately.',
    ref: 'members.service.ts inviteMember inserts a live member row directly, no mailer exists',
  },
} as const satisfies Record<string, Capability>;

export type CapabilityKey = keyof typeof CAPABILITIES;
