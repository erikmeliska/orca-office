import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The built office page (`client/dist`), served by the bridge itself on 127.0.0.1:<port>, so that
 * after a restart everything runs from launchd without Vite (design #21, issue #51). Only files
 * inside `client/dist` are served: the path is decoded once, anything with `..`, a backslash or a
 * NUL is refused, and the resolved real path must still be inside the folder (symlinks included).
 */
export const DEFAULT_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Headers every page response carries: no framing (clickjacking the office's buttons), no sniffing. */
export const PAGE_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
} as const;

export interface StaticFile {
  path: string;
  type: string;
  /** Hashed asset names never change; everything else is checked each time. */
  immutable: boolean;
}

/** The file under `root` a request path names, or null when it names none (or tries to leave). */
export function resolveStatic(root: string, urlPath: string): StaticFile | null {
  let p: string;
  try {
    p = decodeURIComponent((urlPath.split('?')[0] ?? '').split('#')[0] ?? '');
  } catch {
    return null;
  }
  if (!p.startsWith('/') || p.includes('\0') || p.includes('\\') || p.split('/').some((s) => s === '..' || s === '.')) return null;
  if (p.endsWith('/')) p += 'index.html';
  let base: string;
  try {
    base = realpathSync(root);
  } catch {
    return null;
  }
  const file = resolve(base, '.' + p);
  if (!file.startsWith(base + sep)) return null;
  let real: string;
  try {
    real = realpathSync(file);
    if (!real.startsWith(base + sep) || !statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  const ext = extname(real).toLowerCase();
  return { path: real, type: TYPES[ext] ?? 'application/octet-stream', immutable: p.startsWith('/assets/') };
}

/** Whether the built page is there at all. */
export function distReady(root: string): boolean {
  return existsSync(join(root, 'index.html'));
}

/** Reads a resolved file (the office page is a few MB; it's read on each request, no cache to go stale). */
export function readStatic(f: StaticFile): Buffer {
  return readFileSync(f.path);
}
