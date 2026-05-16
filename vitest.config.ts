import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Default `npm test` runs UNIT tests only. Live network tests
    // (`*.live.test.ts`) are excluded here so a fresh checkout — or a CI
    // run with credentials in the environment — never accidentally
    // triggers real sends. Opt in explicitly via `npm run test:live`.
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/**/*.live.test.ts'],
    // Setup auto-loads `.env.dev` / `.env.test*` so opt-in live tests
    // pick up credentials without `--env-file=`. Unit tests don't read
    // these — loading them is a no-op for default runs.
    setupFiles: ['./tests/setup-env.ts'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/types.ts',
        'src/index.ts',
        'src/channels/index.ts',
        'src/providers/index.ts',
        'src/providers/email/index.ts',
        'src/utils/index.ts',
      ],
    },
  },
});
