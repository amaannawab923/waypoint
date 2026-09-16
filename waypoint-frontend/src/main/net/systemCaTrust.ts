import tls from 'node:tls';
import { Agent, setGlobalDispatcher } from 'undici';

/** `tls.getCACertificates` (Node 22.16+) isn't in this project's pinned
 * `@types/node` yet — declared locally rather than bumping that dependency
 * project-wide for one function. */
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
 * `tls.getCACertificates('system')` (Node 22.16+) reads exactly the store
 * macOS/Windows/Linux already trust — this does not weaken verification in
 * any way: a certificate chain that isn't rooted in Node's bundled list OR
 * the OS's own trusted roots still fails, same as today.
 *
 * A no-op on a Node/Electron build old enough not to expose
 * `tls.getCACertificates` at all, or if reading the OS store throws for any
 * reason — those installs just keep today's (unchanged) behavior rather
 * than crashing main-process startup over it.
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
  } catch {
    return;
  }
  setGlobalDispatcher(new Agent({ connect: { ca } }));
}
