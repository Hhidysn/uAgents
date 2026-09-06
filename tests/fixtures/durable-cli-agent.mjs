import fs from 'node:fs';
import path from 'node:path';

const markerDirectory = process.argv[2];
const mode = process.argv[3] ?? 'normal';
if (!markerDirectory || !path.isAbsolute(markerDirectory)) throw new Error('durable-cli-agent requires an absolute marker directory');
fs.mkdirSync(markerDirectory, { recursive: true });

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', async () => {
  increment(path.join(markerDirectory, 'prompt-count.txt'));
  fs.writeFileSync(path.join(markerDirectory, 'prompt-received.txt'), String(Buffer.byteLength(prompt)));

  const session = Buffer.from(`${JSON.stringify({ type: 'session', session_id: 'fixture-session', text: '中文' })}\n`, 'utf8');
  const needle = Buffer.from('中', 'utf8');
  const index = session.indexOf(needle);
  const split = index >= 0 ? index + 1 : Math.max(1, Math.floor(session.length / 2));
  process.stdout.write(session.subarray(0, split));
  await sleep(25);
  await write(process.stdout, session.subarray(split));
  if (mode === 'stderr-limit') {
    // Give the observer a deterministic window to persist accepted before the
    // separate stderr-overflow scenario begins.
    await sleep(100);
    await write(process.stderr, Buffer.alloc(64 * 1024 + 1, 0x78));
  }

  // Leave one valid JSON line incomplete while the process waits. A live
  // observer must not feed it to the parser until the newline is durable.
  process.stdout.write('{"type":"progress","text":"par');
  fs.writeFileSync(path.join(markerDirectory, 'session-emitted.txt'), '1');

  while (!fs.existsSync(path.join(markerDirectory, 'release.txt'))) await sleep(25);
  process.stdout.write('tial 中文"}\n');
  process.stdout.write(`${JSON.stringify({ type: 'terminal', response: 'fixture complete' })}\n`);
  process.stderr.write('fixture diagnostic\n');
  fs.writeFileSync(path.join(markerDirectory, 'terminal-emitted.txt'), '1');
  await sleep(50);
  process.exit(0);
});

function increment(file) {
  let current = 0;
  try { current = Number(fs.readFileSync(file, 'utf8')) || 0; } catch {}
  fs.writeFileSync(file, String(current + 1));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function write(stream, value) {
  return new Promise((resolve, reject) => stream.write(value, error => error ? reject(error) : resolve()));
}
