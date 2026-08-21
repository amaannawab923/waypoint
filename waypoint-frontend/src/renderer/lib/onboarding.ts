// Cosmetic-only login/onboarding gate. There is no real backend or auth — this
// just tracks whether the user has clicked through the one-time "name your
// workspace" step so it doesn't show up again on every visit.
//
// Gate strictly on the literal string 'false'. Anything else — 'true', an
// unrecognized value, or the key being entirely absent (every existing user's
// browser today, and anyone whose localStorage was cleared) — counts as
// onboarded so this feature can never lock out someone who already has state.
// Only signing out ever writes 'false'.

const ONBOARDED_KEY = 'waypoint:onboarded';

export function isOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function markOnboarding(status: 'true' | 'false'): void {
  try {
    localStorage.setItem(ONBOARDED_KEY, status);
  } catch {
    // localStorage unavailable — gating is best-effort only.
  }
}
