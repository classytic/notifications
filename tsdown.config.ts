import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/channels/index.ts',
    'src/utils/index.ts',
  ],
  format: 'esm',
  dts: true,
  clean: true,
  sourcemap: false,
  minify: false,
  // No manual `external` needed — tsdown auto-externalizes
  // all peerDependencies (nodemailer, twilio, firebase-admin, handlebars)
  // and node: builtins from package.json automatically.
});
