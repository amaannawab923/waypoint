import { tryWithRunLock, withRunLock } from './runLock';

// runLock.ts's module-level maps are shared across every test in this
// file (and, in the real app, across every caller) — distinct run ids
// per test keep them from interfering with each other.
let n = 0;
function freshRunId(): string {
  n += 1;
  return `run-lock-test-${n}`;
}

// withRunLock/tryWithRunLock chain onto keyedQueue's serializeBy, which
// defers `fn` to a microtask even for an immediately-available slot — see
// keyedQueue.test.ts's own note. One tick lets a call reach its first
// `await` before a test inspects state that call is expected to have
// already reached.
const tick = () => Promise.resolve();

describe('withRunLock', () => {
  it('serializes two calls for the same run', async () => {
    const runId = freshRunId();
    const order: number[] = [];
    let release: (() => void) | null = null;
    const first = withRunLock(runId, async () => {
      order.push(1);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push(2);
    });
    const second = withRunLock(runId, async () => {
      order.push(3);
    });

    await tick();
    expect(order).toEqual([1]);
    release!();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('tryWithRunLock', () => {
  it('acquires and runs when the run is free', async () => {
    const runId = freshRunId();
    const result = await tryWithRunLock(runId, async () => 'done');
    expect(result).toEqual({ acquired: true, result: 'done' });
  });

  it('skips without waiting when withRunLock already holds the run', async () => {
    const runId = freshRunId();
    let release: (() => void) | null = null;
    const held = withRunLock(runId, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const skipped = await tryWithRunLock(runId, async () => 'should not run');
    expect(skipped).toEqual({ acquired: false });

    release!();
    await held;
  });

  it('a later withRunLock call queues behind a tryWithRunLock that acquired the run, rather than racing it', async () => {
    const runId = freshRunId();
    const order: number[] = [];
    let release: (() => void) | null = null;
    const tried = tryWithRunLock(runId, async () => {
      order.push(1);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push(2);
    });
    const queued = withRunLock(runId, async () => {
      order.push(3);
    });

    await tick();
    expect(order).toEqual([1]);
    release!();
    await Promise.all([tried, queued]);
    expect(order).toEqual([1, 2, 3]);
  });
});
