import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.int-spec.ts'],
    fileParallelism: false,
    passWithNoTests: true,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
