import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(packageRoot, 'dist', 'server.mjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(packageRoot, 'src', 'server.mjs')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['../../../src/*'],
  minifyWhitespace: true,
  legalComments: 'eof',
});
fs.writeFileSync(output, fs.readFileSync(output, 'utf8').replace(/[\t ]+$/gm, ''));
