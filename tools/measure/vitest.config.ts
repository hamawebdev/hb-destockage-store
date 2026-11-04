import { defineConfig } from 'vitest/config';

// Budget fixtures compress whole pages at brotli q11 and spawn the CLI; on the shared machine
// (20+ agents) that can exceed vitest's 5 s default, which would turn load into false failures.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
