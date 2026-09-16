import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Imported after the env is arranged per-test, since the module caches the
// key on first use (see resetKeyCacheForTests).
const { seal, open, resetKeyCacheForTests } = await import('./secretBox.js');

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

let tempDir: string;
const originalKey = process.env.WAYPOINT_SECRET_KEY;
const originalKeyFile = process.env.WAYPOINT_KEY_FILE;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'waypoint-secretbox-'));
  delete process.env.WAYPOINT_SECRET_KEY;
  process.env.WAYPOINT_KEY_FILE = path.join(tempDir, 'nested', 'secret.key');
  resetKeyCacheForTests();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (originalKey === undefined) delete process.env.WAYPOINT_SECRET_KEY;
  else process.env.WAYPOINT_SECRET_KEY = originalKey;
  if (originalKeyFile === undefined) delete process.env.WAYPOINT_KEY_FILE;
  else process.env.WAYPOINT_KEY_FILE = originalKeyFile;
  resetKeyCacheForTests();
});

describe('seal/open', () => {
  it('round-trips a value under the same context', () => {
    const sealed = seal('ATATT-super-secret-token', 'jira');
    expect(open(sealed, 'jira')).toBe('ATATT-super-secret-token');
  });

  it('never stores the plaintext in the sealed value', () => {
    // The whole point: what lands in the database must not contain the token
    // in any directly readable form, including base64 of it.
    const token = 'ATATT-super-secret-token';
    const sealed = seal(token, 'jira');
    expect(sealed).not.toContain(token);
    expect(sealed).not.toContain(Buffer.from(token).toString('base64'));
  });

  it('produces a different ciphertext each time for the same input', () => {
    // A fresh IV per seal. Without it, two identical tokens would seal
    // identically and the database would leak "these are the same secret".
    expect(seal('same', 'jira')).not.toBe(seal('same', 'jira'));
  });

  it('refuses to open under a different context', () => {
    // The AAD binding: a sealed token lifted into another provider's row
    // must not open there.
    const sealed = seal('token', 'jira');
    expect(open(sealed, 'linear')).toBeNull();
  });

  it('refuses to open a tampered ciphertext', () => {
    const sealed = seal('token', 'jira');
    const parts = sealed.split('.');
    const bytes = Buffer.from(parts[3], 'base64');
    bytes[0] ^= 0xff;
    parts[3] = bytes.toString('base64');
    expect(open(parts.join('.'), 'jira')).toBeNull();
  });

  it('returns null rather than throwing for malformed, unversioned, or plaintext values', () => {
    // Every shape a column could hold that isn't a v1 sealed value — including
    // a raw token from before this module existed — has to read as "no usable
    // secret here", not as an exception out of a service call.
    expect(open('', 'jira')).toBeNull();
    expect(open('not-sealed-at-all', 'jira')).toBeNull();
    expect(open('v2.a.b.c', 'jira')).toBeNull();
    expect(open('v1.only.three', 'jira')).toBeNull();
  });

  it('returns null when the key has changed under it', () => {
    // The lost-key case, which is the realistic one: the key file is gone
    // (a recreated container), the sealed value in Postgres survived. It must
    // degrade to "reconnect", never to a crash.
    process.env.WAYPOINT_SECRET_KEY = KEY_A;
    resetKeyCacheForTests();
    const sealed = seal('token', 'jira');

    process.env.WAYPOINT_SECRET_KEY = KEY_B;
    resetKeyCacheForTests();
    expect(open(sealed, 'jira')).toBeNull();
  });
});

describe('key file', () => {
  it('generates a key on first use and reuses it afterwards', () => {
    const sealed = seal('token', 'jira');
    const keyFile = process.env.WAYPOINT_KEY_FILE!;
    expect(existsSync(keyFile)).toBe(true);

    // A cold start with the same file on disk must still open what the
    // previous process sealed — otherwise every restart would silently
    // invalidate the stored connection.
    resetKeyCacheForTests();
    expect(open(sealed, 'jira')).toBe('token');
  });

  it('writes the key file readable only by its owner', () => {
    seal('token', 'jira');
    const mode = statSync(process.env.WAYPOINT_KEY_FILE!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('regenerates when the file holds something that is not a 32-byte key', () => {
    // A truncated or corrupted file must not be silently accepted as a key —
    // it would produce a shorter key and a confusing downstream failure.
    const keyFile = process.env.WAYPOINT_KEY_FILE!;
    seal('token', 'jira');
    const generated = readFileSync(keyFile, 'utf8');
    expect(Buffer.from(generated.trim(), 'base64')).toHaveLength(32);
  });

  it('prefers WAYPOINT_SECRET_KEY over the key file when both are available', () => {
    seal('token', 'jira');
    const keyFile = process.env.WAYPOINT_KEY_FILE!;
    expect(existsSync(keyFile)).toBe(true);

    process.env.WAYPOINT_SECRET_KEY = KEY_A;
    resetKeyCacheForTests();
    const sealedWithEnv = seal('token', 'jira');

    delete process.env.WAYPOINT_SECRET_KEY;
    resetKeyCacheForTests();
    // Sealed under the env key, so the file key must not open it.
    expect(open(sealedWithEnv, 'jira')).toBeNull();
  });

  it('rejects a WAYPOINT_SECRET_KEY that is not 32 bytes', () => {
    process.env.WAYPOINT_SECRET_KEY = Buffer.from('too-short').toString('base64');
    resetKeyCacheForTests();
    expect(() => seal('token', 'jira')).toThrow(/32 base64-encoded bytes/);
  });
});
