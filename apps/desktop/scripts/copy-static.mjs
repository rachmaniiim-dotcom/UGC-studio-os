// Builds the renderer: bundles the React app (src/renderer/main.tsx) with
// esbuild into dist/renderer/renderer.js and copies the static assets.
// Type checking is done by tsc (tsconfig.renderer.json); esbuild only bundles.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'renderer');
mkdirSync(out, { recursive: true });
for (const file of ['index.html', 'styles.css']) copyFileSync(join(root, 'src', 'renderer', file), join(out, file));

const esbuild = createRequire(import.meta.url)('esbuild');
await esbuild.build({
  entryPoints: [join(root, 'src', 'renderer', 'main.tsx')],
  outfile: join(out, 'renderer.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome140',
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
