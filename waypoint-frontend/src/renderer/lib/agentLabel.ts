// Small shared formatter so an agent's name reads unambiguously as "not a
// person" wherever it appears as text alongside human names — comments,
// activity, the assignee picker, notifications. Deliberately never applied
// to the string passed into <Avatar name=...>, since that same value also
// drives the avatar's initials.
export function agentLabel(name: string): string {
  return `${name} (agent)`;
}
