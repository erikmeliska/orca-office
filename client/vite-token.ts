import type { Plugin } from 'vite';
import { loadOrCreateClientToken, mayHaveToken } from '../bridge/src/client-auth.ts';

/** Where the office page fetches its bridge token from (bridge/src/client-auth.ts says why and how). */
export const TOKEN_PATH = '/__orca-office/token';

/**
 * Serves the page's bridge token to the office page itself, and nobody else, in `vite` and
 * `vite preview`; and keeps the page from being framed (clickjacking its buttons).
 */
export function officeToken(clientPort: number): Plugin {
  const middleware = (req: { url?: string; headers: Record<string, string | string[] | undefined> }, res: { statusCode: number; setHeader(k: string, v: string): void; end(body?: string): void }, next: () => void) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    if ((req.url ?? '').split('?')[0] !== TOKEN_PATH) return next();
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
    res.setHeader('Cache-Control', 'no-store');
    if (!mayHaveToken({ host: one(req.headers.host), origin: one(req.headers.origin), fetchSite: one(req.headers['sec-fetch-site']) }, clientPort)) {
      res.statusCode = 403;
      return res.end();
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ token: loadOrCreateClientToken() }));
  };
  return {
    name: 'orca-office-token',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
