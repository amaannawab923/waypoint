import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The dual lookup on its own (W5b moved it out of the MCP handler so the
 * desktop app's resolve route shares it). The properties: both systems are
 * asked concurrently, a native hit never short-circuits Jira, an ambiguous
 * key is refused, and Jira failing to answer is "unknown" unless native
 * already answered. ticketTools.jira.test.ts pins the same through the
 * handler's shaped results; this pins the outcomes themselves.
 */
vi.mock('../db/client.js', () => ({ db: {} }));
vi.mock('../providers/native.js');

const { nativeProvider } = await import('../providers/native.js');
const { ProviderUnavailableError } = await import('../providers/types.js');
const { resolveTicketIdentifier, describeAmbiguity } = await import('./ticketResolution.service.js');

const NATIVE = { provider: 'native', ref: 'wi-1', identifier: 'ENG-4', title: 'Native' } as never;
const JIRA = { provider: 'jira', ref: 'tref-1', identifier: 'ENG-4', title: 'Jira' } as never;

function jira(getByIdentifier: (id: string) => Promise<unknown>) {
  return { getByIdentifier: vi.fn(getByIdentifier) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveTicketIdentifier', () => {
  it('asks both, and answers the one that hit', async () => {
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(null);
    const j = jira(async () => JIRA);

    expect(await resolveTicketIdentifier(j, 'ENG-4')).toEqual({ kind: 'found', ticket: JIRA });
    expect(nativeProvider.getByIdentifier).toHaveBeenCalledWith('ENG-4');
    expect((j as { getByIdentifier: ReturnType<typeof vi.fn> }).getByIdentifier).toHaveBeenCalledWith('ENG-4');
  });

  it('still asks Jira when native hits — a native hit never short-circuits the ambiguity check', async () => {
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(NATIVE);
    const j = jira(async () => JIRA);

    expect(await resolveTicketIdentifier(j, 'ENG-4')).toEqual({
      kind: 'ambiguous',
      native: NATIVE,
      jira: JIRA,
    });
    expect((j as { getByIdentifier: ReturnType<typeof vi.fn> }).getByIdentifier).toHaveBeenCalled();
  });

  it('with Jira disconnected, only native is asked', async () => {
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(NATIVE);
    expect(await resolveTicketIdentifier(null, 'ENG-4')).toEqual({ kind: 'found', ticket: NATIVE });
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(null);
    expect(await resolveTicketIdentifier(null, 'ENG-4')).toEqual({ kind: 'missing' });
  });

  it('Jira failing to answer: native wins when it hit, else the outcome is unavailable — never "missing"', async () => {
    const error = new ProviderUnavailableError('timed out');
    const j = jira(async () => {
      throw error;
    });
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(NATIVE);
    expect(await resolveTicketIdentifier(j, 'ENG-4')).toEqual({ kind: 'found', ticket: NATIVE });
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(null);
    expect(await resolveTicketIdentifier(j, 'ENG-4')).toEqual({ kind: 'unavailable', error });
  });

  it('an explicit provider looks only there; jira with no credential is jira_off', async () => {
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(NATIVE);
    const j = jira(async () => JIRA);
    expect(await resolveTicketIdentifier(j, 'ENG-4', 'native')).toEqual({ kind: 'found', ticket: NATIVE });
    expect((j as { getByIdentifier: ReturnType<typeof vi.fn> }).getByIdentifier).not.toHaveBeenCalled();
    expect(await resolveTicketIdentifier(j, 'ENG-4', 'jira')).toEqual({ kind: 'found', ticket: JIRA });
    expect(nativeProvider.getByIdentifier).toHaveBeenCalledTimes(1);
    expect(await resolveTicketIdentifier(null, 'ENG-4', 'jira')).toEqual({ kind: 'jira_off' });
  });

  it('a non-provider error is a bug and propagates', async () => {
    vi.mocked(nativeProvider.getByIdentifier).mockResolvedValue(null);
    const j = jira(async () => {
      throw new TypeError('boom');
    });
    await expect(resolveTicketIdentifier(j, 'ENG-4')).rejects.toThrow('boom');
  });

  it('describes an ambiguity with both titles', () => {
    expect(describeAmbiguity('ENG-4', NATIVE, JIRA)).toBe(
      '"ENG-4" is ambiguous: it names a Waypoint ticket ("Native") and a Jira issue ("Jira").',
    );
  });
});
