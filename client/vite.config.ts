import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { officeToken } from './vite-token';

const root = import.meta.dirname;

/** Same variables and defaults as the bridge (bridge/src/config.ts). */
function port(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : fallback;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number, got "${raw}"`);
  return n;
}
const bridgePort = port('ORCA_OFFICE_PORT', 4317);
const clientPort = port('ORCA_OFFICE_CLIENT_PORT', 5317);

export default defineConfig({
  root,
  plugins: [officeToken(clientPort)],
  define: {
    __ORCA_OFFICE_BRIDGE_PORT__: JSON.stringify(bridgePort),
  },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        main: resolve(root, 'index.html'),
        live: resolve(root, 'live.html'),
      },
    },
  },
  // The bridge accepts /client only from this exact origin, so the port is fixed (strictPort).
  server: { host: '127.0.0.1', port: clientPort, strictPort: true },
  preview: { host: '127.0.0.1', port: clientPort, strictPort: true },
});
