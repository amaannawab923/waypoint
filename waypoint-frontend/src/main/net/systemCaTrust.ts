import tls from 'node:tls';
import log from 'electron-log';
import { Agent, setGlobalDispatcher } from 'undici';

/** `tls.getCACertificates` (Node 22.15+) isn't in this project's pinned
 * `@types/node` yet — declared locally rather than bumping that dependency
 * project-wide for one function. Node 22.15 is why `package.json` pins
 * `electron` to `^35.4.0`, not just `^35.0.2` — Electron 35.0.x–35.3.x
 * bundle Node 22.14, where this function doesn't exist yet; the `typeof`
 * guard below makes that a silent no-op rather than a crash, but the
 * floor exists so a routine `npm install` can't quietly regress into it. */
type CaCertificateStore = 'bundled' | 'system' | 'extra' | 'default';
interface TlsWithCaCertificates {
  getCACertificates?: (type: CaCertificateStore) => Array<string | Buffer>;
}

/**
 * Makes this process's global `fetch` (Jira, the hosted-workspace backend,
 * sign-in, GitHub proposal approval — every main-process HTTPS caller,
 * since they all use the same ambient `fetch`) trust whatever this
 * machine's OS certificate store additionally trusts, on top of Node's own
 * bundled Mozilla CA list.
 *
 * Closes a real, reported gap: a corporate TLS-inspecting proxy (Netskope,
 * Zscaler, ...) re-signs outbound HTTPS with its own root certificate.
 * macOS/Windows already trust that root once IT/MDM installs it — Chrome
 * and Safari consult the OS trust store, so they work fine — but Node's
 * `fetch` only ever consults its bundled list, so every main-process
 * request failed with an opaque "self signed certificate in certificate
 * chain" wrapped in a generic "couldn't reach Jira" message.
 *
 * `tls.getCACertificates('system')` reads exactly the store macOS/Windows/
 * Linux already trust — this does not weaken verification in any way: a
 * certificate chain that isn't rooted in Node's bundled list OR the OS's
 * own trusted roots still fails, same as today (round 2 review re-verified
 * this live, including that a malformed/garbage entry in the OS store is
 * silently skipped by `tls.createSecureContext` rather than breaking every
 * other request).
 *
 * `setGlobalDispatcher` (from `undici`, imported explicitly rather than
 * relying on Node's own bundled copy — see package.json's own comment on
 * that dependency) reconfigures the *ambient* global `fetch` itself, not a
 * separate export: Electron bundles its own, separately-loaded copy of
 * undici for that built-in `fetch`, and the two only end up sharing one
 * dispatcher because `setGlobalDispatcher` writes it onto a well-known
 * `Symbol.for` key that any undici copy reads regardless of which
 * node_modules install it came from. Confirmed live, round 1 and 2, that
 * this repo's pinned Electron version actually reads it. There is no
 * cheap, non-tautological way to verify that from inside this function
 * itself at every startup (round 2 review: an earlier version of this
 * function tried, and the check could never actually fail given how
 * `setGlobalDispatcher` is implemented — a passing check that can't fail
 * is worse than no check, so it was removed rather than kept for
 * appearances) — if a future Electron/undici version ever stops sharing
 * that symbol, the failure mode is silent: main-process HTTPS quietly
 * goes back to Node's bundled trust only. `electron-log`'s warning below
 * is reserved for the one failure this function genuinely can detect —
 * reading the OS trust store itself failing — not for that one.
 *
 * A no-op on a Node/Electron build old enough not to expose
 * `tls.getCACertificates` at all — that install just keeps today's
 * (unchanged) behavior rather than crashing main-process startup over it.
 */
export function installSystemCaTrust(): void {
  const tlsModule = tls as unknown as TlsWithCaCertificates;
  const { getCACertificates } = tlsModule;
  if (typeof getCACertificates !== 'function') return;
  let ca: Array<string | Buffer>;
  try {
    ca = [
      ...getCACertificates('bundled'),
      ...getCACertificates('system'),
      // Node's own NODE_EXTRA_CA_CERTS convention — a manual escape hatch
      // for a store this OS-store read doesn't happen to pick up.
      ...getCACertificates('extra'),
    ];
  } catch (err) {
    log.warn(
      "installSystemCaTrust: couldn't read this OS's certificate store — main-process HTTPS calls will use Node's default trust only.",
      err,
    );
    return;
  }
  setGlobalDispatcher(new Agent({ connect: { ca } }));
}
