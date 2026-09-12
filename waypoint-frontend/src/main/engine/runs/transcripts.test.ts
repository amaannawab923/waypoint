import type { DaemonTranscriptTurn } from './daemonApi';
import { createTranscriptKeeper, fitTurns } from './transcripts';

// The transcript kept in the ledger (ROAD-124): read from the daemon or
// given, skipped when nothing changed, the oldest turns dropped to fit.

const turn = (seq: number, text = `t${seq}`): DaemonTranscriptTurn => ({
  id: `t${seq}`,
  seq,
  initiator: 'user',
  items: [{ kind: 'message', role: 'assistant', text }],
  outcome: { kind: 'done', reason: 'end_turn' },
});

function harness(history: DaemonTranscriptTurn[] | Error = [turn(1), turn(2)]) {
  const saveTranscript = jest.fn(async (_id: string, turns: unknown[]) => ({
    turnCount: turns.length,
  }));
  const getHistory = jest.fn(async () => {
    if (history instanceof Error) throw history;
    return history;
  });
  const logger = { info: jest.fn(), warn: jest.fn() };
  const keeper = createTranscriptKeeper({
    ledger: { saveTranscript },
    daemon: () => ({ getHistory }),
    logger,
  });
  return { keeper, saveTranscript, getHistory, logger };
}

describe('createTranscriptKeeper', () => {
  it('reads the daemon and saves; a second capture with nothing new is skipped', async () => {
    const { keeper, saveTranscript, getHistory } = harness();
    await keeper.capture('run-a');
    expect(getHistory).toHaveBeenCalledWith('run-a', 500);
    expect(saveTranscript).toHaveBeenCalledTimes(1);
    expect(saveTranscript.mock.calls[0][1]).toHaveLength(2);
    await keeper.capture('run-a');
    expect(saveTranscript).toHaveBeenCalledTimes(1);
  });

  it('takes the turns it is given without reading, and saves when they grew', async () => {
    const { keeper, saveTranscript, getHistory } = harness();
    await keeper.capture('run-a', [turn(1)]);
    expect(getHistory).not.toHaveBeenCalled();
    await keeper.capture('run-a', [turn(1), turn(2), turn(3)]);
    expect(saveTranscript).toHaveBeenCalledTimes(2);
    expect(saveTranscript.mock.calls[1][1]).toHaveLength(3);
  });

  it('an empty history, a daemon that cannot answer, or a ledger that refuses is never a throw', async () => {
    const empty = harness([]);
    await empty.keeper.capture('run-a');
    expect(empty.saveTranscript).not.toHaveBeenCalled();

    const gone = harness(new Error('session not found'));
    await gone.keeper.capture('run-a');
    expect(gone.saveTranscript).not.toHaveBeenCalled();
    expect(gone.logger.info).toHaveBeenCalledWith(
      'engine: transcript not readable',
      expect.objectContaining({ runId: 'run-a' }),
    );

    const refused = harness();
    refused.saveTranscript.mockRejectedValueOnce(new Error('413'));
    await expect(refused.keeper.capture('run-a')).resolves.toBeUndefined();
    expect(refused.logger.warn).toHaveBeenCalledWith(
      'engine: transcript not kept',
      expect.objectContaining({ runId: 'run-a' }),
    );
    // Not remembered as saved: the next capture tries again.
    await refused.keeper.capture('run-a');
    expect(refused.saveTranscript).toHaveBeenCalledTimes(2);
  });

  it('two captures of one run in flight take turns', async () => {
    const { keeper, saveTranscript } = harness();
    await Promise.all([
      keeper.capture('run-a', [turn(1)]),
      keeper.capture('run-a', [turn(1), turn(2)]),
    ]);
    expect(
      saveTranscript.mock.calls.map(([, t]) => (t as unknown[]).length),
    ).toEqual([1, 2]);
  });

  it('does nothing with the engine down', async () => {
    const saveTranscript = jest.fn();
    const keeper = createTranscriptKeeper({
      ledger: { saveTranscript },
      daemon: () => null,
      logger: { info: jest.fn(), warn: jest.fn() },
    });
    await keeper.capture('run-a');
    expect(saveTranscript).not.toHaveBeenCalled();
  });
});

describe('fitTurns', () => {
  it('drops the oldest turns until the transcript fits', () => {
    const turns = Array.from({ length: 50 }, (_, i) =>
      turn(i + 1, 'x'.repeat(1000)),
    );
    const kept = fitTurns(turns, 20_000);
    expect(kept.length).toBeLessThan(50);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[kept.length - 1].seq).toBe(50);
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(20_000);
  });
  it('keeps a transcript that fits as it is', () => {
    const turns = [turn(1), turn(2)];
    expect(fitTurns(turns)).toBe(turns);
  });
});
