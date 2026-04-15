// Re-export shared domain types so main-side modules can
// `import type { ... } from '../types'`. Renderer imports the same types
// via `@shared/types` path alias to avoid bundling Node types into Chromium.
export * from '../shared/types';
