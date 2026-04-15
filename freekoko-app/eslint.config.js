// Flat config, intentionally minimal. Linting is not gating for P2.
export default [
  {
    ignores: ['node_modules/**', 'out/**', 'dist/**', 'resources/**'],
  },
  {
    rules: {
      'no-unused-vars': 'off',
    },
  },
];
