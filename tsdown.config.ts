import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/channels/index.ts',
    'src/utils/index.ts',
  ],
  format: 'esm',
  dts: true,
  sourcemap: false,
  minify: false,
  external: ['nodemailer'],
});
