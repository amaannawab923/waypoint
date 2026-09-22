import {
  ULTRAFAST_PIN,
  resolveUltrafastPaths,
  findUv,
  provisionPythonEnv,
  isProvisioned,
  type CommandResult,
  type CommandRunner,
} from './pythonEnv';

describe('resolveUltrafastPaths', () => {
  it('nests everything under <userData>/ultrafast', () => {
    const paths = resolveUltrafastPaths(
      '/Users/x/Library/Application Support/Waypoint',
    );
    expect(paths.root).toBe(
      '/Users/x/Library/Application Support/Waypoint/ultrafast',
    );
    expect(paths.venvDir).toBe(`${paths.root}/venv`);
    expect(paths.venvPython).toBe(`${paths.venvDir}/bin/python`);
    expect(paths.venvBrowserHarness).toBe(
      `${paths.venvDir}/bin/browser-harness`,
    );
    expect(paths.pinnedFile).toBe(`${paths.root}/pinned.json`);
    // F1: the two 0600 runtime secret files registration.ts's
    // buildServerEnv writes instead of putting the key/OAuth token in the
    // env it hands the daemon.
    expect(paths.runtimeKeyFile).toBe(`${paths.root}/runtime-key`);
    expect(paths.runtimeOauthTokenFile).toBe(
      `${paths.root}/runtime-oauth-token`,
    );
  });
});

describe('findUv', () => {
  it('prefers a PATH match over the fixed candidates', () => {
    const found = findUv({
      pathEnv: '/custom/bin:/usr/bin',
      homeDir: '/Users/x',
      existsSync: (p) => p === '/custom/bin/uv',
    });
    expect(found).toBe('/custom/bin/uv');
  });

  it('falls back to the Homebrew Apple Silicon prefix', () => {
    const found = findUv({
      pathEnv: '/usr/bin',
      homeDir: '/Users/x',
      existsSync: (p) => p === '/opt/homebrew/bin/uv',
    });
    expect(found).toBe('/opt/homebrew/bin/uv');
  });

  it('falls back to ~/.local/bin/uv', () => {
    const found = findUv({
      pathEnv: '/usr/bin',
      homeDir: '/Users/x',
      existsSync: (p) => p === '/Users/x/.local/bin/uv',
    });
    expect(found).toBe('/Users/x/.local/bin/uv');
  });

  it('returns null rather than throwing when uv is nowhere', () => {
    expect(
      findUv({
        pathEnv: '/usr/bin',
        homeDir: '/Users/x',
        existsSync: () => false,
      }),
    ).toBeNull();
  });
});

/** A fake filesystem + command runner shared by the provisioning tests. */
function makeFakeEnv() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const calls: Array<{ command: string; args: string[] }> = [];
  const commandResults: CommandResult[] = [
    { code: 0, stdout: '', stderr: '' }, // uv venv
    { code: 0, stdout: '', stderr: '' }, // uv pip install
    { code: 0, stdout: '', stderr: '' }, // browser-harness telemetry disable
  ];
  let callIndex = 0;
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    const result = commandResults[callIndex] ?? {
      code: 0,
      stdout: '',
      stderr: '',
    };
    callIndex += 1;
    return result;
  };
  return {
    files,
    dirs,
    calls,
    commandResults,
    run,
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    readFileSync: (p: string) => {
      const contents = files.get(p);
      if (contents === undefined) throw new Error(`ENOENT: ${p}`);
      return contents;
    },
    writeFileSync: (p: string, data: string) => files.set(p, data),
    mkdirSync: (p: string) => dirs.add(p),
  };
}

describe('provisionPythonEnv', () => {
  it('runs venv, install, and telemetry-disable in order, then writes the pin marker', async () => {
    const env = makeFakeEnv();
    const paths = resolveUltrafastPaths('/tmp/waypoint-1');
    const result = await provisionPythonEnv({
      paths,
      uvPath: '/opt/homebrew/bin/uv',
      run: env.run,
      existsSync: env.existsSync,
      readFileSync: env.readFileSync,
      writeFileSync: env.writeFileSync,
      mkdirSync: env.mkdirSync,
    });

    expect(result).toEqual({ ok: true, alreadyProvisioned: false });
    expect(env.calls[0]).toEqual({
      command: '/opt/homebrew/bin/uv',
      args: ['venv', '--python', '3.12', paths.venvDir],
    });
    expect(env.calls[1].args).toEqual([
      'pip',
      'install',
      '--python',
      paths.venvPython,
      `jev-ultrafast @ git+https://github.com/browser-use/jev-ultrafast@${ULTRAFAST_PIN.jevCommit}`,
      `browser-harness==${ULTRAFAST_PIN.harnessVersion}`,
    ]);
    expect(env.calls[2]).toEqual({
      command: paths.venvBrowserHarness,
      args: ['telemetry', 'disable'],
    });
    const written = JSON.parse(env.files.get(paths.pinnedFile) as string);
    expect(written.jevCommit).toBe(ULTRAFAST_PIN.jevCommit);
    expect(written.harnessVersion).toBe(ULTRAFAST_PIN.harnessVersion);
  });

  it('is idempotent: a second call against a matching pin runs nothing', async () => {
    const env = makeFakeEnv();
    const paths = resolveUltrafastPaths('/tmp/waypoint-2');
    env.files.set(
      paths.pinnedFile,
      JSON.stringify({
        jevCommit: ULTRAFAST_PIN.jevCommit,
        harnessVersion: ULTRAFAST_PIN.harnessVersion,
        provisionedAt: 1,
      }),
    );
    env.files.set(paths.venvPython, ''); // the venv's python exists

    const result = await provisionPythonEnv({
      paths,
      uvPath: '/opt/homebrew/bin/uv',
      run: env.run,
      existsSync: env.existsSync,
      readFileSync: env.readFileSync,
      writeFileSync: env.writeFileSync,
      mkdirSync: env.mkdirSync,
    });

    expect(result).toEqual({ ok: true, alreadyProvisioned: true });
    expect(env.calls).toHaveLength(0);
  });

  it('re-provisions when the pin on disk does not match the current pin', async () => {
    const env = makeFakeEnv();
    const paths = resolveUltrafastPaths('/tmp/waypoint-3');
    env.files.set(
      paths.pinnedFile,
      JSON.stringify({
        jevCommit: 'stale-commit',
        harnessVersion: '0.1.0',
        provisionedAt: 1,
      }),
    );
    env.files.set(paths.venvPython, '');

    const result = await provisionPythonEnv({
      paths,
      uvPath: '/opt/homebrew/bin/uv',
      run: env.run,
      existsSync: env.existsSync,
      readFileSync: env.readFileSync,
      writeFileSync: env.writeFileSync,
      mkdirSync: env.mkdirSync,
    });

    expect(result.ok).toBe(true);
    expect(env.calls.length).toBeGreaterThan(0);
  });

  it('reports uv venv failing as a sentence, without attempting install', async () => {
    const env = makeFakeEnv();
    env.commandResults[0] = {
      code: 1,
      stdout: '',
      stderr: 'python3.12 not found',
    };
    const paths = resolveUltrafastPaths('/tmp/waypoint-4');

    const result = await provisionPythonEnv({
      paths,
      uvPath: '/opt/homebrew/bin/uv',
      run: env.run,
      existsSync: env.existsSync,
      readFileSync: env.readFileSync,
      writeFileSync: env.writeFileSync,
      mkdirSync: env.mkdirSync,
    });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('python3.12 not found'),
    });
    expect(env.calls).toHaveLength(1);
  });

  it('reports the install step failing without swallowing it as success', async () => {
    const env = makeFakeEnv();
    env.commandResults[1] = {
      code: 1,
      stdout: '',
      stderr: 'no matching distribution',
    };
    const paths = resolveUltrafastPaths('/tmp/waypoint-5');

    const result = await provisionPythonEnv({
      paths,
      uvPath: '/opt/homebrew/bin/uv',
      run: env.run,
      existsSync: env.existsSync,
      readFileSync: env.readFileSync,
      writeFileSync: env.writeFileSync,
      mkdirSync: env.mkdirSync,
    });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('no matching distribution'),
    });
    expect(env.files.has(paths.pinnedFile)).toBe(false);
  });

  it('a failing telemetry-disable is logged but does not fail provisioning', async () => {
    const env = makeFakeEnv();
    env.commandResults[2] = { code: 1, stdout: '', stderr: 'unknown command' };
    const paths = resolveUltrafastPaths('/tmp/waypoint-6');
    const warn = jest.fn();

    const result = await provisionPythonEnv({
      paths,
      uvPath: '/opt/homebrew/bin/uv',
      run: env.run,
      existsSync: env.existsSync,
      readFileSync: env.readFileSync,
      writeFileSync: env.writeFileSync,
      mkdirSync: env.mkdirSync,
      logger: { warn },
    });

    expect(result).toEqual({ ok: true, alreadyProvisioned: false });
    expect(warn).toHaveBeenCalled();
    expect(env.files.has(paths.pinnedFile)).toBe(true);
  });

  it('serializes concurrent calls against the same venv into one provisioning run', async () => {
    const env = makeFakeEnv();
    const paths = resolveUltrafastPaths('/tmp/waypoint-7');
    const [first, second] = await Promise.all([
      provisionPythonEnv({
        paths,
        uvPath: '/opt/homebrew/bin/uv',
        run: env.run,
        existsSync: env.existsSync,
        readFileSync: env.readFileSync,
        writeFileSync: env.writeFileSync,
        mkdirSync: env.mkdirSync,
      }),
      provisionPythonEnv({
        paths,
        uvPath: '/opt/homebrew/bin/uv',
        run: env.run,
        existsSync: env.existsSync,
        readFileSync: env.readFileSync,
        writeFileSync: env.writeFileSync,
        mkdirSync: env.mkdirSync,
      }),
    ]);
    expect(first).toEqual(second);
    // Exactly one provisioning attempt's worth of commands ran, not two.
    expect(env.calls).toHaveLength(3);
  });
});

describe('isProvisioned', () => {
  it('is true only when the marker matches the pin and the venv python exists', () => {
    const paths = resolveUltrafastPaths('/tmp/waypoint-8');
    const files = new Map<string, string>([
      [
        paths.pinnedFile,
        JSON.stringify({
          jevCommit: ULTRAFAST_PIN.jevCommit,
          harnessVersion: ULTRAFAST_PIN.harnessVersion,
          provisionedAt: 1,
        }),
      ],
      [paths.venvPython, ''],
    ]);
    const existsSync = (p: string) => files.has(p);
    const readFileSync = (p: string) => files.get(p) as string;
    expect(isProvisioned(paths, { existsSync, readFileSync })).toBe(true);
  });

  it('is false when nothing has been written yet', () => {
    const paths = resolveUltrafastPaths('/tmp/waypoint-9');
    expect(
      isProvisioned(paths, { existsSync: () => false, readFileSync: () => '' }),
    ).toBe(false);
  });
});
