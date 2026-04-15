// Flat config for ESLint 9 with TypeScript support.
// Added by the CI lint gate — previously linting was not gating for P2, so
// the config was a no-op. This config:
//   - Uses the .mjs extension so Node loads it as ESM regardless of package
//     "type". `build/after-pack.cjs` stays CommonJS (electron-builder loads
//     it by filename).
//   - Wires the TypeScript parser for .ts/.tsx so the codebase actually
//     parses (generics, satisfies, etc. were previously all parse errors).
//   - Keeps rules close to the pre-existing ruleset (no-unused-vars off)
//     while adding TS-equivalent overrides. This PR is about making lint
//     run, not about retightening standards.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'resources/**',
      'build/**',
      'scripts/**',
      '*.config.js',
      '*.config.cjs',
      '*.config.mjs',
      'electron.vite.config.ts',
      'vitest.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        // Node (main/preload/electron) + browser (renderer) + test.
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        globalThis: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        queueMicrotask: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        ReadableStream: 'readonly',
        WritableStream: 'readonly',
        TransformStream: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        CustomEvent: 'readonly',
        MessageChannel: 'readonly',
        MessagePort: 'readonly',
        performance: 'readonly',
        crypto: 'readonly',
        // Browser / DOM (renderer).
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLAudioElement: 'readonly',
        HTMLAnchorElement: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        NodeList: 'readonly',
        Audio: 'readonly',
        AudioBuffer: 'readonly',
        AudioContext: 'readonly',
        AudioBufferSourceNode: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        PointerEvent: 'readonly',
        DragEvent: 'readonly',
        FocusEvent: 'readonly',
        InputEvent: 'readonly',
        ResizeObserver: 'readonly',
        MutationObserver: 'readonly',
        IntersectionObserver: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        // Vitest / test globals are only used when imports are explicit, so
        // we don't need to enumerate them here.
      },
    },
    rules: {
      // Preserve pre-existing rule: the project historically turned off the
      // base unused-vars rule. Turn off the TS equivalent too but allow an
      // underscore-prefix opt-in for "intentionally unused" (used in a few
      // places to silence warnings deliberately).
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // The codebase uses `any` deliberately at a handful of boundary
      // points (test fakes for IPC glue, MLX wire typing). Keep the rule
      // active so the existing `eslint-disable-next-line` directives on
      // those call-sites are not dead — flipping it off would turn every
      // one of those disables into an "Unused eslint-disable" warning.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Empty object types / interfaces are fine for React prop shapes.
      '@typescript-eslint/no-empty-object-type': 'off',
      // React 19 adds `use()` / Actions which the plugin version >=5.0
      // already knows about. Keep the recommended rules on.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Tests can use non-null assertions and looser typing.
    files: ['**/*.test.ts', '**/*.test.tsx', 'electron/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];
