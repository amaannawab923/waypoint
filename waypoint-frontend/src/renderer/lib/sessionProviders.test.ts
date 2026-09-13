import {
  resolveProviderSelection,
  workspaceDefaultProvider,
} from './sessionProviders';

jest.mock('@/data/api', () => ({ detectLocalClaudeCode: jest.fn() }));

// The cases emdash's own provider-selection.test.ts proves, with two ids
// so the fallback order is visible. `codex` is not a supported id in
// Waypoint yet; the rule is typed on the union, so the cast is confined
// to this table.
type Id = 'claude' | 'codex';
const ordered = ['claude', 'codex'] as unknown as readonly 'claude'[];
const pick = (over: Partial<Parameters<typeof resolveProviderSelection>[0]>) =>
  resolveProviderSelection({
    orderedProviderIds: ordered,
    defaultProviderId: 'claude',
    providerOverride: null,
    installedProviderIds: ['claude'],
    availabilityKnown: true,
    ...over,
  } as never) as { providerId: Id | null; createDisabled: boolean };

describe('resolveProviderSelection (emdash’s rule)', () => {
  it('the default, when installed', () => {
    expect(pick({})).toEqual({ providerId: 'claude', createDisabled: false });
  });

  it('the override wins over the default', () => {
    expect(
      pick({
        providerOverride: 'codex' as never,
        installedProviderIds: ['claude', 'codex'] as never,
      }),
    ).toEqual({ providerId: 'codex', createDisabled: false });
  });

  it('a default that is not installed falls back to the first installed, in catalogue order', () => {
    expect(
      pick({
        defaultProviderId: 'codex' as never,
        installedProviderIds: ['claude'],
      }),
    ).toEqual({ providerId: 'claude', createDisabled: false });
  });

  it('nothing installed: no provider, Start disabled', () => {
    expect(pick({ installedProviderIds: [] })).toEqual({
      providerId: null,
      createDisabled: true,
    });
  });

  it('an override that is not installed keeps the choice but disables Start', () => {
    expect(
      pick({
        providerOverride: 'codex' as never,
        installedProviderIds: ['claude'],
      }),
    ).toEqual({ providerId: 'codex', createDisabled: true });
  });

  it('before availability is known nothing is assumed: the default stands, Start is not disabled for it', () => {
    expect(
      pick({ availabilityKnown: false, installedProviderIds: [] }),
    ).toEqual({ providerId: 'claude', createDisabled: false });
  });
});

describe('workspaceDefaultProvider', () => {
  it('uses the stored id when supported, else the built-in default', () => {
    expect(workspaceDefaultProvider('claude')).toBe('claude');
    expect(workspaceDefaultProvider(null)).toBe('claude');
    expect(workspaceDefaultProvider('codex')).toBe('claude');
    expect(workspaceDefaultProvider('gpt-9')).toBe('claude');
  });
});
