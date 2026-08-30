// No agent or network: measure whether a child outlives this tool's process.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const [mode, destination] = process.argv.slice(2);
if (!destination) throw new Error('Usage: node scripts/probe-detached.mjs start|read ABSOLUTE_DIRECTORY');
const root = resolve(destination);
if (mode === 'child') {
  await writeFile(join(root, 'started.json'), JSON.stringify({ pid: process.pid, started: Date.now() }));
  await new Promise(resolve => setTimeout(resolve, 12000));
  await writeFile(join(root, 'completed.json'), JSON.stringify({ status: 'succeeded', completed: Date.now() }));
} else if (mode === 'start') {
  await mkdir(root); // Exclusive directory: do not overwrite another probe.
  const nonce = randomUUID();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', root], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
  await writeFile(join(root, 'launch.json'), JSON.stringify({ nonce, pid: child.pid, launched: Date.now() }));
  console.log(JSON.stringify({ nonce, pid: child.pid, directory: root }));
} else if (mode === 'read') {
  for (const name of ['launch', 'started', 'completed']) {
    try { console.log(JSON.stringify({ name, ...JSON.parse(await readFile(join(root, `${name}.json`), 'utf8')) })); }
    catch (error) { if (error.code !== 'ENOENT') throw error; console.log(JSON.stringify({ name, exists: false })); }
  }
} else throw new Error('Unknown probe mode');
