import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scenarios/**/*.lab.ts'],
    globalSetup: ['src/labImages.ts'],
    fileParallelism: false,
    testTimeout: 90 * 60_000,
    hookTimeout: 15 * 60_000,
    teardownTimeout: 5 * 60_000,
  },
});
