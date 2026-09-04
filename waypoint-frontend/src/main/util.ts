/* eslint import/prefer-default-export: off */
import { URL } from 'url';

export function resolveHtmlPath(htmlFileName: string) {
  if (process.env.NODE_ENV === 'development') {
    // 11212, not this template's conventional 1212 default — moved to
    // avoid colliding with another project's dev server on the same
    // machine (see check-port-in-use.js and webpack.config.renderer.dev.ts).
    const port = process.env.PORT || 11212;
    const url = new URL(`http://localhost:${port}`);
    url.pathname = htmlFileName;
    return url.href;
  }
  // Served by the custom `app://` protocol handler registered in main.ts
  // (protocol.handle('app', ...)) rather than a bare file:// load — file://
  // has no server behind it at all, so createBrowserRouter's real paths
  // (e.g. a hard refresh at /projects/proj-launch/tickets) would have
  // nothing to resolve to. The app:// handler serves real files when they
  // exist and falls back to index.html otherwise, the same SPA-fallback
  // behavior webpack-dev-server's historyApiFallback already provides in
  // dev.
  const url = new URL(`app://waypoint`);
  url.pathname = htmlFileName;
  return url.href;
}
