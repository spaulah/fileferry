import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests use the fake's source directly, so they run without a build step.
      '@fileferry/fake-graph': fileURLToPath(new URL('../fake-graph/src/index.ts', import.meta.url)),
      '@fileferry/fake-dropbox': fileURLToPath(new URL('../fake-dropbox/src/index.ts', import.meta.url))
    }
  },
  test: {
    include: ['test/**/*.test.ts']
  }
});
