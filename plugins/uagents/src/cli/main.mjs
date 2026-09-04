import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { notOk, ok } from '../protocol/envelope.mjs';
import { fail } from '../protocol/errors.mjs';
import { createRegistry, targetDescriptor } from '../registry/registry.mjs';
import { resolveStateRoot, UnifiedRuntime } from '../runtime/api.mjs';

export async function execute(argv, options = {}) {
  const registry = options.registry ?? createRegistry();
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    request: { type: 'string' }, 'state-dir': { type: 'string' }, model: { type: 'string' }, refresh: { type: 'boolean' },
    limit: { type: 'string' }, cursor: { type: 'string' }, config: { type: 'string' }, format: { type: 'string' },
  } });
  if (values.format && values.format !== 'json') fail('unsupported_capability', 'Only JSON output is implemented in this release.');
  const [command, subject, ...extra] = positionals;
  if (!command || extra.length) fail('usage', 'Invalid uagents command arguments.');

  if (command === 'targets') return ok(Object.entries(registry.targets).filter(([, value]) => value.enabled).map(([id]) => id));
  if (command === 'capabilities') return ok({ target: subject, ...targetDescriptor(registry, required(subject, 'target')) });
  if (command === 'models') {
    const target = required(subject, 'target'); targetDescriptor(registry, target);
    return ok(Object.values(registry.models).filter(model => model.target === target && model.enabled));
  }
  if (command === 'config' && subject === 'validate') {
    const config = values.config ? JSON.parse(fs.readFileSync(values.config, 'utf8')) : {};
    return ok({ valid: true, registry_version: createRegistry(config).version });
  }

  const stateRoot = resolveStateRoot(values['state-dir'], options.env ?? process.env);
  const runtime = new UnifiedRuntime({ stateRoot, registry, spawnWorker: options.spawnWorker });
  try {
    if (command === 'probe') return ok(await runtime.probe(required(subject, 'target'), { model: values.model ?? 'default' }));
    if (command === 'submit') {
      if (subject || !values.request) fail('usage', 'submit requires --request FILE.');
      const input = JSON.parse(fs.readFileSync(values.request, 'utf8'));
      return ok(runtime.submit(input));
    }
    if (command === 'status') return ok(runtime.status(required(subject, 'task id')));
    if (command === 'result') return ok(runtime.result(required(subject, 'task id')));
    if (command === 'cancel') return ok(runtime.cancel(required(subject, 'task id')));
    if (command === 'list') return ok(runtime.listTasks({ cursor: values.cursor ?? null, limit: values.limit ? Number(values.limit) : 50 }));
    if (command === 'reconcile') return ok(await runtime.reconcile(required(subject, 'task id')));
    fail('usage', `Unknown command: ${command}`);
  } finally { runtime.close(); }
}

export async function main(argv = process.argv.slice(2), io = console) {
  try { io.log(JSON.stringify(await execute(argv))); return 0; }
  catch (error) { io.log(JSON.stringify(notOk(error))); return 1; }
}

function required(value, label) { if (!value) fail('usage', `Missing ${label}.`); return value; }
