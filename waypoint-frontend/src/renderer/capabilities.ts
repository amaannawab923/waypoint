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
    state: 'partial',
    note: 'Only "Notify on mentions" is honored, for in-app notifications. Email, push and comment notifications are saved but not sent yet.',
  },
  'notifications.production': {
    state: 'partial',
    note: 'Only @mentions in comments send a notification today. Assignments, status changes and replies do not yet.',
    ref: 'notifications.service.ts notifyMentionsInComment is the only producer',
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
  'sprints.burndownCompleted': {
    state: 'partial',
    note: 'Two measured points — sprint start and close. No daily history is recorded yet.',
  },
  'sprints.burndownUpcoming': {
    state: 'partial',
    note: "One measured point — the sprint's planned start. Daily tracking begins once the sprint is under way.",
  },
  'agents.runtime': {
    state: 'not-wired',
    note: 'This agent is configured but not yet running. Assignments will queue.',
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
