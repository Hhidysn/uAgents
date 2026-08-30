import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const scenario = process.argv[2];
const model = `gemini-fixture-${scenario}`;
const session = 'fixture-session';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const start = () => emit({ event: 'init', conversation_id: session, init: {
  cwd: process.cwd(), model: scenario === 'wrong-model' ? 'gemini-another-route' : model,
  agent: 'uagents-text', tools: scenario === 'unsafe' ? ['write_to_file'] : [], permission_mode: 'request-review',
} });
if (scenario === 'object-error-before') emit({ event: 'result', result: { conversation_id: '', status: 'ERROR', error: { message: 'fixture failure' } } });
else if (scenario === 'slow-init') setTimeout(start, 2000); else start();
let received = false;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.event !== 'user') return;
  received = true;
  fs.appendFileSync('received.txt', 'submitted\n');
  if (scenario === 'pipe-held') spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true }).unref();
  if (scenario === 'hang' || scenario === 'pipe-held') { setTimeout(() => process.exit(0), 15000); return; }
  setTimeout(() => {
    if (scenario === 'truncated') { process.exit(0); return; }
    if (scenario === 'malformed') { process.stdout.write('{bad-json}\n'); return; }
    if (scenario === 'large') { process.stdout.write('x'.repeat(1048577)); return; }
    if (scenario === 'null') { emit(null); return; }
    if (scenario === 'missing-fields') { emit({ event: 'result', result: {} }); return; }
    const result = { event: 'result', result: {
      conversation_id: scenario === 'wrong-session' ? 'unrelated-session' : session,
      status: scenario === 'error-zero' ? 'ERROR' : scenario === 'waiting' ? 'WAITING' : 'SUCCESS',
      response: '可归属的中文结果 ✓', usage: { total_tokens: 0 },
    } };
    if (scenario === 'unicode') {
      const bytes = Buffer.from(JSON.stringify(result) + '\n');
      const index = bytes.indexOf(Buffer.from('中文')) + 1;
      process.stdout.write(bytes.subarray(0, index));
      setTimeout(() => process.stdout.write(bytes.subarray(index)), 20);
    } else { emit(result); if (scenario === 'duplicate-result') emit(result); }
  }, 600);
}).on('close', () => {
  if (!received && scenario === 'probe-error') {
    emit({ event: 'result', result: { conversation_id: session, status: 'ERROR', error: { message: 'fixture failure' } } });
    process.exit(1);
  }
  if (!received && scenario !== 'slow-init') process.exit(0);
});
