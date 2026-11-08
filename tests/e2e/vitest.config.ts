import { defineConfig } from 'vitest/config';

// npm run e2e → vitest run --config tests/e2e/vitest.config.ts
// One worker at a time: the specs share one seeded D1 and two local Workers.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['**/*.spec.ts'],
    globalSetup: ['./setup.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 300_000,
    reporters: ['default', 'json'],
    outputFile: { json: '../../artifacts/e2e/e2e-results.json' },
  },
});
