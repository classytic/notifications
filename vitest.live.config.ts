import { defineConfig } from 'vitest/config';

/**
 * Separate vitest config for live network tests.
 *
 * Activated only by `npm run test:live`. Kept apart from the default
 * `vitest.config.ts` so `npm test` can never glob a live test file by
 * accident — even with `.env.dev` mounted in the workspace.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.live.test.ts'],
    exclude: ['**/node_modules/**'],
    setupFiles: ['./tests/setup-env.ts'],
    testTimeout: 30_000,
  },
});
