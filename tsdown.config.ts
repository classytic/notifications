import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/channels/index.ts',
    'src/providers/index.ts',
    'src/utils/index.ts',
  ],
  format: 'esm',
  dts: true,
  clean: true,
  // No sourcemaps / declaration maps: they would require publishing the
  // TypeScript source (or embedding it in .map files), which we don't ship.
  sourcemap: false,
  minify: false,
  // Third-party peers (nodemailer, twilio, firebase-admin, handlebars) and node:
  // builtins are auto-externalized by tsdown from package.json — no manual entry needed.
  //
  // Sibling scopes are NOT left to that, deliberately. Auto-externalization keys off the
  // DECLARATION, so it protects nothing the moment a sibling is imported without being
  // declared, or a declaration is dropped in a cleanup — and the resulting build prints
  // `✔ Build complete` while shipping a second copy of a stateful kernel. That is a
  // correctness bug (two registries, two outbox relays), not a size regression.
  //
  // REGEX, never bare strings: a string matches only the EXACT specifier, not subpaths
  // — falsified in ../mongokit/tsdown.config.ts.
  deps: {
    neverBundle: [/^@classytic\//, /^@spinekit\//],
  },
});
