import type { DaemonTranscriptTurn } from './daemonApi';
import { createTranscriptKeeper, mergeTurns, fitTurns } from './transcripts';

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
  const getTranscript = jest.fn(async () => null);
  const keeper = createTranscriptKeeper({
    ledger: { saveTranscript, getTranscript },
    daemon: () => ({ getHistory }),
    logger,
  });
  return { keeper, saveTranscript, getHistory, getTranscript, logger };
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
      ledger: { saveTranscript, getTranscript: jest.fn(async () => null) },
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

  // Found in review: a single turn over the cap — a verification turn's
  // screenshots — used to empty the whole snapshot. Its images go first;
  // its text stays.
  it('a lone turn over the cap keeps its text and loses its images, never the whole snapshot', () => {
    const shot = (data: string) => ({
      kind: 'unknown-tool-call',
      id: 'shot',
      seq: 2,
      toolCallId: 't',
      title: 'take_screenshot',
      status: 'done',
      images: [{ mimeType: 'image/png', data }],
    });
    const big = {
      ...turn(1, 'The report.'),
      items: [
        { kind: 'message', role: 'user', text: 'verify' },
        shot('x'.repeat(30_000)),
        {
          kind: 'tool-group',
          id: 'g',
          seq: 3,
          children: [shot('y'.repeat(30_000))],
        },
        { kind: 'message', role: 'assistant', text: 'The report.' },
      ],
    } as unknown as DaemonTranscriptTurn;
    const kept = fitTurns([big], 20_000);
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept)).not.toContain('images');
    expect(JSON.stringify(kept)).toContain('The report.');
    expect(JSON.stringify(kept)).toContain('take_screenshot');
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(20_000);
  });

  it('sheds old turns before any images, and only the images it must', () => {
    const withShot = (seq: number, data: string): DaemonTranscriptTurn =>
      ({
        ...turn(seq, 'text'),
        items: [
          {
            kind: 'unknown-tool-call',
            id: `shot-${seq}`,
            seq: 1,
            images: [{ mimeType: 'image/png', data }],
          },
        ],
      }) as unknown as DaemonTranscriptTurn;
    // Two turns, each ~6 KB of image: together over 10 KB, each alone under.
    const kept = fitTurns(
      [withShot(1, 'a'.repeat(6_000)), withShot(2, 'b'.repeat(6_000))],
      10_000,
    );
    expect(kept.map((t) => t.seq)).toEqual([2]);
    expect(JSON.stringify(kept)).toContain('bbbb');
  });

  it('is empty only when even a text-only last turn cannot fit', () => {
    expect(fitTurns([turn(1, 'x'.repeat(50_000))], 20_000)).toEqual([]);
  });
});

// Never-lock (design §5.4): a session the provider could not restore
// starts its history afresh; the snapshot's earlier turns are kept in
// front of the daemon's page so a continued conversation reads whole.
describe('mergeTurns', () => {
  const mk = (id: string, seq: number): DaemonTranscriptTurn => ({
    id,
    seq,
    initiator: 'user',
    items: [],
    outcome: { kind: 'done' },
  });

  it('keeps the snapshot turns the page lacks, in order, then the page; the page wins on a shared id', () => {
    const snapshot = [mk('a', 1), mk('b', 2), mk('c', 3)];
    const page = [
      {
        ...mk('c', 1),
        items: [{ kind: 'message', role: 'user', text: 'newer' }],
      },
      mk('d', 2),
    ];
    expect(mergeTurns(snapshot, page).map((t) => t.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(mergeTurns(snapshot, page)[2].items).toHaveLength(1);
  });

  it('is the page itself when nothing is missing', () => {
    const page = [mk('a', 1)];
    expect(mergeTurns([mk('a', 1)], page)).toBe(page);
    expect(mergeTurns([], page)).toBe(page);
  });

  it("the keeper stitches: a fresh page of one turn is saved behind the snapshot's two", async () => {
    const saveTranscript = jest.fn(async (_id: string, turns: unknown[]) => ({
      turnCount: turns.length,
    }));
    const getTranscript = jest.fn(async () => ({
      turns: [mk('a', 1), mk('b', 2)],
      turnCount: 2,
    }));
    const keeper = createTranscriptKeeper({
      ledger: { saveTranscript, getTranscript },
      daemon: () => ({ getHistory: jest.fn(async () => [mk('c', 1)]) }),
      logger: { info: jest.fn(), warn: jest.fn() },
    });
    await keeper.capture('run-a');
    expect(saveTranscript).toHaveBeenCalledWith(
      'run-a',
      expect.arrayContaining([
        expect.objectContaining({ id: 'a' }),
        expect.objectContaining({ id: 'c' }),
      ]),
    );
    expect((saveTranscript.mock.calls[0][1] as unknown[]).length).toBe(3);
    // Read once per run per process.
    await keeper.capture('run-a', [mk('c', 1), mk('d', 2)]);
    expect(getTranscript).toHaveBeenCalledTimes(1);
    expect((saveTranscript.mock.calls[1][1] as unknown[]).length).toBe(4);
  });
});
