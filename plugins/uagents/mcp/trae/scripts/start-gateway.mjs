import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const gateway = path.join(packageRoot, 'dist', 'gateway.cjs');
const configuredRoot = process.env.UAGENTS_TRAE_STATE_DIR
  ?? (process.env.PLUGIN_DATA ? path.join(process.env.PLUGIN_DATA, 'trae-cn-gateway') : path.join(os.homedir(), '.uagents', 'trae-cn'));
if (!path.isAbsolute(configuredRoot)) throw new Error('UAGENTS_TRAE_STATE_DIR must be absolute.');
const requestedRoot = path.resolve(configuredRoot);
fs.mkdirSync(requestedRoot, { recursive: true });
const stateRoot = fs.realpathSync(requestedRoot);
const realPackageRoot = fs.realpathSync(packageRoot);
const relative = path.relative(realPackageRoot, stateRoot);
if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Gateway state must remain outside the plugin.');

const env = {
  ...process.env,
  TRAECN_GATEWAY_HOST: '127.0.0.1',
  TRAECN_GATEWAY_PORT: process.env.UAGENTS_TRAE_GATEWAY_PORT ?? process.env.TRAECN_GATEWAY_PORT ?? '8788',
  // Instance identity for the supervisor's client-side nonce check (Gate 5).
  // The capability token keeps flowing via ...process.env and is never logged.
  TRAECN_GATEWAY_INSTANCE_NONCE: process.env.TRAECN_GATEWAY_INSTANCE_NONCE ?? '',
  TRAECN_CDP_HOST: '127.0.0.1',
  TRAECN_REMOTE_DEBUGGING_PORT: process.env.UAGENTS_TRAE_CDP_PORT ?? process.env.TRAECN_REMOTE_DEBUGGING_PORT ?? '9223',
  TRAECN_STRICT_CDP_PORT: '1',
  TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH: path.join(stateRoot, 'active-queue.json'),
  TRAECN_TASK_HISTORY_PERSISTENCE_PATH: path.join(stateRoot, 'task-history.json'),
  TRAECN_TASK_EVENT_PERSISTENCE_PATH: path.join(stateRoot, 'task-events.json'),
  TRAECN_AUDIT_LOG_DIR: path.join(stateRoot, 'audit'),
  TRAECN_LOG_DIR: path.join(stateRoot, 'logs'),
  TRAECN_AUTO_START_TRAE: '0',
  TRAECN_ENABLE_MOCK_BRIDGE: '0',
  TRAECN_BACKGROUND_MAX_RETRIES: '0',
};

const child = spawn(process.execPath, [gateway], { env, stdio: 'inherit', windowsHide: true });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', error => { throw error; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
