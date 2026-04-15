import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(here, 'electron/main.ts'),
        formats: ['cjs'],
      },
      rollupOptions: {
        output: {
          entryFileNames: 'index.js',
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(here, 'shared'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve(here, 'electron/preload.ts'),
        formats: ['cjs'],
      },
      rollupOptions: {
        output: {
          entryFileNames: 'index.js',
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(here, 'shared'),
      },
    },
  },
  renderer: {
    root: resolve(here, 'src'),
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(here, 'src/index.html'),
      },
    },
    resolve: {
      alias: {
        '@': resolve(here, 'src'),
        '@shared': resolve(here, 'shared'),
      },
    },
    server: {
      port: 5173,
    },
  },
});
