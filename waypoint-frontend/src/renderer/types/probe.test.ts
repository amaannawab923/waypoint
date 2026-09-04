import type { Probe } from './probe';

describe('Probe<T>', () => {
  it('narrows to `value` only once `state` has been checked to be `present`', () => {
    const probe: Probe<{ version: string }> = {
      state: 'present',
      value: { version: '1.2.3' },
      observedAt: '2026-09-03T00:00:00.000Z',
      via: 'claude --version',
    };

    if (probe.state !== 'present') {
      throw new Error('unreachable — probe.state is present');
    }
    expect(probe.value.version).toBe('1.2.3');
    expect(probe.via).toBe('claude --version');
  });

  it('carries a reason and via on `absent`, distinct from `unknown`', () => {
    const absent: Probe<string> = {
      state: 'absent',
      reason: 'claude: command not found',
      observedAt: '2026-09-03T00:00:00.000Z',
      via: 'claude --version',
    };
    const unknown: Probe<string> = { state: 'unknown' };

    expect(absent.state).toBe('absent');
    expect(unknown.state).toBe('unknown');
    // `unknown` has no `via`/`reason` at all — nothing was ever run.
    expect('via' in unknown).toBe(false);
  });

  it('carries a reason and via on `error`, as a distinct branch from `absent`', () => {
    const errored: Probe<string> = {
      state: 'error',
      reason: 'ECONNREFUSED',
      observedAt: '2026-09-03T00:00:00.000Z',
      via: 'GET /health',
    };

    expect(errored.state).toBe('error');
    expect(errored.reason).toBe('ECONNREFUSED');
  });

  it('rejects a `present` value with no `via` at compile time', () => {
    // @ts-expect-error — `via` is required on `present`; this is the exact
    // shape of the fabricated-status bug §7.2 makes unrepresentable.
    const bad: Probe<string> = {
      state: 'present',
      value: 'x',
      observedAt: '2026-09-03T00:00:00.000Z',
    };
    expect(bad).toBeDefined();
  });

  it('rejects an unknown `state` literal at compile time', () => {
    // @ts-expect-error — 'connected' is not one of the five branches.
    const bad: Probe<string> = { state: 'connected' };
    expect(bad).toBeDefined();
  });
});
