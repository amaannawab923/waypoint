import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Authenticated encryption for the handful of third-party secrets this
 * process has to keep (today: one Jira API token — see
 * services/jiraConnection.service.ts).
 *
 * WHY THIS EXISTS AT ALL, and why it is this small.
 *
 * Electron's main process gets `safeStorage`, which hands a secret to the OS
 * keychain and is the right answer there — it is what waypoint-frontend's
 * jiraAuth.ts uses. This is a plain Node/Express process: no Electron, no
 * keychain binding, and (per docker-compose.yml) frequently not even the same
 * machine's user session. So the realistic choice is not "keychain vs. this",
 * it is "this vs. a plaintext column".
 *
 * The threat this actually closes is the mundane one, and it is worth being
 * precise rather than implying more: a token leaking through a channel that
 * carries the DATABASE but not the filesystem — a pg_dump handed to someone
 * for debugging, a volume snapshot, a backup, a `SELECT *` in psql or Drizzle
 * Studio, a screenshared query result. It does NOT defend against an attacker
 * who already has arbitrary read on this host: the key file is readable by the
 * same user this process runs as, by construction, because there is nowhere
 * else on a keychain-less host to put it. Claiming otherwise would be the
 * dishonest part; deliberately not doing so is why there is no elaborate key
 * derivation ceremony here to imply a strength that isn't there.
 *
 * AES-256-GCM rather than CBC or a bare XOR-with-a-key: GCM authenticates as
 * well as encrypts, so a ciphertext someone edited in the database fails to
 * open LOUDLY instead of decrypting to garbage that then gets sent to Jira as
 * a password. The AAD (see seal/open below) binds a ciphertext to the row it
 * belongs to, so a sealed token cannot be copied from one provider's row into
 * another's and still open.
 */

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM's standard nonce length; anything else costs a rehash internally
const FORMAT_VERSION = 'v1';

/**
 * `.` is safe as a field separator: every other field is standard base64,
 * whose alphabet is A-Z a-z 0-9 + / = and contains no dot.
 */
const SEPARATOR = '.';

/**
 * Where the key lives when it is not supplied directly.
 *
 * Under the home directory rather than anywhere in the repo, so that a key
 * can never be committed by an over-broad `git add` and never end up in a
 * Docker build context. The consequence in the containerised setup
 * (docker-compose.yml) is that the key is scoped to the container's own
 * filesystem unless a volume is mounted for it — see `loadKey` for what a
 * lost key does, which is a deliberate, survivable outcome rather than a
 * failure mode to guard against.
 */
function keyFilePath(): string {
  return process.env.WAYPOINT_KEY_FILE || path.join(homedir(), '.waypoint', 'secret.key');
}

let cachedKey: Buffer | null = null;

/**
 * Resolves the key, generating and persisting one on first use.
 *
 * WAYPOINT_SECRET_KEY (base64, 32 bytes) wins when set, so a deployment that
 * wants to own key management — inject it from a secret manager, rotate it on
 * its own schedule, keep it off disk entirely — can, without this module
 * needing to know how. Everything else falls back to a generated file, which
 * is what makes the default developer path zero-configuration: nothing to set
 * up, nothing to remember, and no prompt that a first-run user would answer by
 * pasting a token into a plaintext column instead.
 *
 * The file is written with the `wx` flag, not a read-then-write: two requests
 * arriving together on a cold start would otherwise both see no key, both
 * generate one, and the second would overwrite the first — silently
 * invalidating a token the first had just sealed. `wx` makes exactly one
 * writer win and the loser re-read.
 */
function loadKey(): Buffer {
  if (cachedKey) return cachedKey;

  const supplied = process.env.WAYPOINT_SECRET_KEY;
  if (supplied) {
    const key = Buffer.from(supplied, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(`WAYPOINT_SECRET_KEY must be ${KEY_BYTES} base64-encoded bytes`);
    }
    cachedKey = key;
    return key;
  }

  const file = keyFilePath();
  try {
    const existing = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (existing.length === KEY_BYTES) {
      cachedKey = existing;
      return existing;
    }
    // A file that exists but holds something the wrong length is not a key.
    // Fall through and treat it as absent rather than silently deriving a
    // usable-looking key from a truncated one.
  } catch {
    // Absent or unreadable — generate below.
  }

  const generated = randomBytes(KEY_BYTES);
  // 0o700 / 0o600: the only protection the file itself can offer is "no other
  // user on this host". mkdirSync's recursive mode applies to directories it
  // creates and is a no-op on one that already exists, which is fine — an
  // existing ~/.waypoint is the user's own to have set permissions on.
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, generated.toString('base64'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    cachedKey = generated;
    return generated;
  } catch {
    // Lost the `wx` race (or the path became unwritable). Re-read: whoever
    // won wrote a perfectly good key, and using theirs is the whole point.
    const winner = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    if (winner.length !== KEY_BYTES) throw new Error('Could not establish a local encryption key');
    cachedKey = winner;
    return winner;
  }
}

/**
 * Seals `plaintext`, binding it to `context`.
 *
 * `context` becomes GCM's additional authenticated data: it is not encrypted
 * and not stored, it is re-supplied at open time and the open fails if it
 * differs. Passing the row's own identity (the provider name) means a sealed
 * token lifted out of one row and pasted into another does not open — the
 * ciphertext is only valid where it was put.
 */
export function seal(plaintext: string, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    FORMAT_VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(SEPARATOR);
}

/**
 * Opens a sealed value, or returns null.
 *
 * Null rather than a throw, for every failure: a wrong key, a lost key, a
 * tampered ciphertext, a value from a future format version, and a
 * still-plaintext value from before this module existed are all the SAME
 * situation from a caller's point of view — "there is no usable secret here"
 * — and every caller's correct response is identical: report the connection
 * as needing to be re-established and let the user reconnect. Distinguishing
 * them would only give an error message somewhere the chance to explain
 * exactly which cryptographic assumption failed, to someone who cannot act on
 * the difference.
 *
 * The lost-key case is the one worth naming, because it is not hypothetical:
 * the container's filesystem is recreated, the key is gone, the sealed
 * credential in Postgres survives it and can never be opened again. That is
 * the intended outcome. A credential nobody can decrypt is inert, and asking
 * for the token again costs a user thirty seconds.
 */
export function open(sealed: string, context: string): string | null {
  const parts = sealed.split(SEPARATOR);
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) return null;
  const [, ivB64, tagB64, ciphertextB64] = parts;
  try {
    const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextB64, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Test seam. The key is cached for the life of the process (reading a file on
 * every Jira request would be pointless I/O), which means a test that changes
 * WAYPOINT_SECRET_KEY between cases would otherwise keep using the first one.
 */
export function resetKeyCacheForTests(): void {
  cachedKey = null;
}
