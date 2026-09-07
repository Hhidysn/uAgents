import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { notOk, ok } from '../protocol/envelope.mjs';
import { fail } from '../protocol/errors.mjs';
import { createRegistry, targetDescriptor } from '../registry/registry.mjs';
import { resolveStateRoot, UnifiedRuntime } from '../runtime/api.mjs';

export async function execute(argv, options = {}) {
  const registry = options.registry ?? createRegistry();
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    request: { type: 'string' }, 'request-stdin': { type: 'boolean' }, 'state-dir': { type: 'string' }, model: { type: 'string' }, refresh: { type: 'boolean' },
    limit: { type: 'string' }, cursor: { type: 'string' }, config: { type: 'string' }, format: { type: 'string' },
  } });
  if (values.format && !['json', 'table'].includes(values.format)) fail('invalid_request', 'format must be json or table.');
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
  // The supervisor is constructed only for commands that need it. An explicit
  // options.supervisor key (including null) is honored verbatim so tests and
  // hosts can pin the lifecycle behavior.
  const supervisor = 'supervisor' in options
    ? options.supervisor
    : ['ensure', 'stop', 'reconcile', 'resume'].includes(command) ? await createSupervisor() : null;
  const runtime = new UnifiedRuntime({ stateRoot, registry, spawnWorker: options.spawnWorker, supervisor });
  try {
    if (command === 'probe') return ok(await runtime.probe(required(subject, 'target'), { model: values.model ?? 'default' }));
    if (command === 'ensure') {
      const target = required(subject, 'target'); targetDescriptor(registry, target);
      return ok(await runtime.ensure(target, { refresh: values.refresh === true }));
    }
    if (command === 'submit') {
      if (subject || Boolean(values.request) === Boolean(values['request-stdin'])) fail('usage', 'submit requires exactly one of --request FILE or --request-stdin.');
      const serialized = values.request
        ? fs.readFileSync(values.request, 'utf8')
        : await readStdin(options.stdin ?? process.stdin);
      const input = parseJson(serialized, 'Request');
      return ok(runtime.submit(input));
    }
    if (command === 'status') return ok(runtime.status(required(subject, 'task id')));
    if (command === 'result') return ok(runtime.result(required(subject, 'task id')));
    if (command === 'cancel') return ok(runtime.cancel(required(subject, 'task id')));
    if (command === 'list') return ok(runtime.listTasks({ cursor: values.cursor ?? null, limit: values.limit ? Number(values.limit) : 50 }));
    if (command === 'reconcile') return ok(await runtime.reconcile(required(subject, 'task id')));
    if (command === 'resume') return ok(await runtime.resume(required(subject, 'task id')));
    if (command === 'stop') {
      const target = required(subject, 'target'); targetDescriptor(registry, target);
      return ok(await runtime.stop(target));
    }
    fail('usage', `Unknown command: ${command}`);
  } finally { runtime.close(); }
}

// The managed lifecycle supervisor is constructed only for commands that need it.
async function createSupervisor() {
  const { createHostSupervisor } = await import('../host/target-supervisor.mjs');
  return createHostSupervisor();
}

export async function main(argv = process.argv.slice(2), io = console) {
  try {
    const envelope = await execute(argv);
    io.log(argv.includes('table') && argv.includes('--format') ? renderTable(envelope) : JSON.stringify(envelope));
    return 0;
  }
  catch (error) { io.log(JSON.stringify(notOk(error))); return 1; }
}

function required(value, label) { if (!value) fail('usage', `Missing ${label}.`); return value; }

function parseJson(value, label) {
  try { return JSON.parse(value); }
  catch { fail('invalid_request', `${label} must contain valid JSON.`); }
}

async function readStdin(stream) {
  let value = '';
  for await (const chunk of stream) {
    value += chunk.toString();
    if (Buffer.byteLength(value) > 1_048_576) fail('invalid_request', 'Request stdin exceeds 1 MiB.');
  }
  return value;
}

function renderTable(envelope) {
  if (!envelope.ok) return JSON.stringify(envelope);
  const rows = Array.isArray(envelope.data) ? envelope.data : envelope.data?.tasks ?? [envelope.data];
  if (!rows.length) return '(no rows)';
  if (rows.every(row => typeof row !== 'object' || row === null)) return rows.map(row => String(row)).join('\n');
  const normalized = rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')])));
  const columns = [...new Set(normalized.flatMap(row => Object.keys(row)))];
  const widths = columns.map(column => Math.max(column.length, ...normalized.map(row => String(row[column] ?? '').length)));
  const line = row => columns.map((column, index) => String(row[column] ?? '').padEnd(widths[index])).join(' | ').trimEnd();
  return [line(Object.fromEntries(columns.map(column => [column, column]))), widths.map(width => '-'.repeat(width)).join('-|-'), ...normalized.map(line)].join('\n');
}
