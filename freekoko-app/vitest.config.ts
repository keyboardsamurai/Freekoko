import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// React plugin import is typed against the outer `vite` (6.x) while
// vitest ships its own `vite` (5.x). They are runtime-compatible, so we
// relax the type at the config boundary.
const reactPlugin = react() as unknown;

export default defineConfig({
  plugins: [reactPlugin as never],
  test: {
    environment: 'node',
    // Per-file environment: renderer (`src/`) tests run in happy-dom so
    // React Testing Library can render into a document; main/electron
    // tests stay in node for speed.
    environmentMatchGlobs: [
      ['src/**', 'happy-dom'],
    ],
    include: [
      'electron/**/*.test.ts',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'shared/**/*.test.ts',
    ],
    globals: false,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'shared'),
    },
  },
});
