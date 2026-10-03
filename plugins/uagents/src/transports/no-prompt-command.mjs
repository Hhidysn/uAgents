import { spawn } from 'node:child_process';

// Run informational native CLI commands without a shell or stdin prompt. Each
// output stream has its own byte budget so a noisy command cannot exhaust RAM.
export function runNoPromptCommand(command, args, {
  env,
  cwd,
  timeout = 10_000,
  maxBuffer = 2 * 1024 * 1024,
  windowsHide = true,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        env, cwd, windowsHide, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let limitError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    const cleanup = () => clearTimeout(timer);
    const failAndKill = (code, message) => {
      if (settled) return;
      limitError = Object.assign(new Error(message), { code });
      child.kill();
    };
    const collect = (chunks, stream) => chunk => {
      if (settled || limitError) return;
      const size = Buffer.byteLength(chunk);
      if (stream === 'stdout') stdoutBytes += size;
      else stderrBytes += size;
      if ((stream === 'stdout' ? stdoutBytes : stderrBytes) > maxBuffer) {
        failAndKill('output_limit_exceeded', `Native command ${stream} exceeded its ${maxBuffer}-byte limit.`);
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    child.stdout.on('data', collect(stdout, 'stdout'));
    child.stderr.on('data', collect(stderr, 'stderr'));
    child.once('error', error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once('close', (status, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (limitError) {
        reject(limitError);
        return;
      }
      if (timedOut) {
        reject(Object.assign(new Error(`Native command exceeded ${timeout} ms.`), { code: 'ETIMEDOUT', signal }));
        return;
      }
      resolve({ status, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}
