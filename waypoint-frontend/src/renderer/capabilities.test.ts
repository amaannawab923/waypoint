import {
  CAPABILITIES,
  type Capability,
  type CapabilityKey,
} from './capabilities';

const EXPECTED_KEYS: CapabilityKey[] = [
  'webhooks.delivery',
  'exports.download',
  'automations.autoArchive',
  'automations.autoClose',
  'profile.notificationPrefs',
  'preferences.firstDayOfWeek',
  'requests.publicForm',
  'sprints.burndown',
  'tickets.drafts',
  'agents.runtime',
  'scratchpad.editing',
];

describe('CAPABILITIES', () => {
  it('has exactly the eleven registered surfaces, and nothing else', () => {
    expect(Object.keys(CAPABILITIES).sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  it('gives every non-shipped entry a note — the thing <NotWired/> has to render', () => {
    const entries: Capability[] = Object.values(CAPABILITIES);
    const nonShipped = entries.filter((entry) => entry.state !== 'shipped');

    // All eleven are non-shipped today — guards against this test quietly
    // asserting nothing if the register is ever pared down to zero.
    expect(nonShipped.length).toBe(entries.length);

    nonShipped.forEach((entry) => {
      expect(typeof entry.note).toBe('string');
      expect((entry.note ?? '').length).toBeGreaterThan(0);
    });
  });

  it('is not missing the two currently-unshipped states this register exists to expose', () => {
    expect(CAPABILITIES['sprints.burndown'].state).toBe('partial');
    expect(CAPABILITIES['agents.runtime'].state).toBe('not-wired');
  });
});
