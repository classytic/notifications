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
  // No manual `external` needed — tsdown auto-externalizes
  // all peerDependencies (nodemailer, twilio, firebase-admin, handlebars)
  // and node: builtins from package.json automatically.
});
