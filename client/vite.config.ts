import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

export default defineConfig({
  root,
  define: {
    __EXCALIDRAW_ASSETS__: JSON.stringify('/assets/excalidraw/'),
  },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
        warn(warning);
      },
      input: {
        main: resolve(root, 'index.html'),
        live: resolve(root, 'live.html'),
      },
    },
  },
  server: { host: '127.0.0.1', port: 5317 },
});
