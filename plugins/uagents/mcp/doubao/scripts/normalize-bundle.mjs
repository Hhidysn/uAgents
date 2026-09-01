import fs from 'node:fs';

const bundle = new URL('../dist/server.mjs', import.meta.url);
const source = fs.readFileSync(bundle, 'utf8');
fs.writeFileSync(bundle, source.replace(/[\t ]+$/gm, ''));
