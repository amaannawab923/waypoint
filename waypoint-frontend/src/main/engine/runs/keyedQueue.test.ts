import { isBusy, serializeBy } from './keyedQueue';

// serializeBy chains onto `previous.then(fn, fn)` — even an immediately-
// resolved `previous` defers `fn` to a microtask, so a call never runs
// synchronously up to its first `await`. Every test below lets one
// microtask turn (`await tick()`) elapse before inspecting state a call
// is expected to have already reached.
const tick = () => Promise.resolve();
// The queue's own cleanup (deleting a settled key) is itself chained a
// further two microtask turns past what a caller's `await serializeBy(...)`
// observes (settled → bare → the cleanup .then on bare) — a macrotask
// turn reliably flushes all of them.
const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

describe('serializeBy', () => {
  it('runs calls for the same key one at a time, in order', async () => {
    const queues = new Map<string, Promise<unknown>>();
    const order: number[] = [];
    let release1: (() => void) | null = null;
    const first = serializeBy(queues, 'a', async () => {
      order.push(1);
      await new Promise<void>((resolve) => {
        release1 = resolve;
      });
      order.push(2);
    });
    const second = serializeBy(queues, 'a', async () => {
      order.push(3);
    });

    // The second call has not run yet — it's queued behind the first.
    await tick();
    expect(order).toEqual([1]);
    release1!();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('does not serialize different keys against each other', async () => {
    const queues = new Map<string, Promise<unknown>>();
    const order: string[] = [];
    let releaseA: (() => void) | null = null;
    const a = serializeBy(queues, 'a', async () => {
      await new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      order.push('a');
    });
    const b = serializeBy(queues, 'b', async () => {
      order.push('b');
    });

    await b;
    expect(order).toEqual(['b']);
    releaseA!();
    await a;
    expect(order).toEqual(['b', 'a']);
  });

  it('a rejected call does not jam the queue for its key', async () => {
    const queues = new Map<string, Promise<unknown>>();
    const first = serializeBy(queues, 'a', async () => {
      throw new Error('boom');
    });
    const second = serializeBy(queues, 'a', async () => 'ok');

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
  });

  it('removes the key from the queue once its work settles', async () => {
    const queues = new Map<string, Promise<unknown>>();
    await serializeBy(queues, 'a', async () => {});
    await flush();
    expect(isBusy(queues, 'a')).toBe(false);
  });
});

describe('isBusy', () => {
  it('is true only while work is enqueued or running for that key', async () => {
    const queues = new Map<string, Promise<unknown>>();
    expect(isBusy(queues, 'a')).toBe(false);
    let release: (() => void) | null = null;
    const running = serializeBy(queues, 'a', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await tick();
    expect(isBusy(queues, 'a')).toBe(true);
    expect(isBusy(queues, 'b')).toBe(false);
    release!();
    await running;
    await flush();
    expect(isBusy(queues, 'a')).toBe(false);
  });
});
