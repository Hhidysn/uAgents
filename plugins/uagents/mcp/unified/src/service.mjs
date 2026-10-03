import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server';
import { createServer } from './server.mjs';
import { bootstrapCheckin } from '../../../src/checkin/scheduler.mjs';
import { CHECKIN_TARGETS } from '../../../src/checkin/checkin.mjs';
import { loadRegistry } from '../../../src/registry/config-file.mjs';
import { runToolChild, runSchedulerChild } from './service-child.mjs';
import { runRegisteredTask } from '../../../src/runtime/worker-factory.mjs';
import { ToolRunner } from '../../../src/service/tool-runner.mjs';
import { executionConfig, initializeServiceConfig, readServiceConfig, readServiceToken, SERVICE_CONFIG_SCHEMA, serviceChildEnvironment, tokenMatches, validateServiceConfig, verifyServiceFiles } from '../../../src/service/config.mjs';
import { notOk, ok } from '../../../src/protocol/envelope.mjs';
import { fail } from '../../../src/protocol/errors.mjs';

const entry = fileURLToPath(import.meta.url);

export async function bootstrapServiceCheckin(config, options = {}) {
  try {
    // Match service children: only the service's registry file may override defaults.
    const registry = loadRegistry({ configPath: config.registry_config, env: {} });
    const targets = config.targets.filter(target => CHECKIN_TARGETS.includes(target) && registry.targets[target]?.enabled);
    return await bootstrapCheckin({ ...options, targets });
  } catch { return { status: 'failed', reason: 'auto_registration_failed' }; }
}

export async function createLocalService({ config, token = readServiceToken(config.token_file), runner = null, scheduler = true, childEntry = entry } = {}) {
  config = validateServiceConfig(config);
  runner ??= new ToolRunner({ config, entry: childEntry });
  const handlers = Object.fromEntries(config.tools.map(name => [name, input => runner.invoke(name, input)]));
  const handler = createMcpHandler(() => createServer({ handlers, enabledTools: config.tools }), { legacy: 'stateless', responseMode: 'auto' });
  let closing = false, schedulerChild = null, schedulerRestart = null, closePromise = null;
  let schedulerHealth = { running: false, last_scan_at_ms: null, last_progress_at_ms: null };
  const started = Date.now();
  const launchScheduler = () => {
    if (closing) return;
    schedulerChild = spawn(process.execPath, [childEntry, '--scheduler-child'], {
      windowsHide: true, env: serviceChildEnvironment(config), stdio: ['pipe', 'ignore', 'pipe', 'ipc'],
    });
    schedulerChild.stderr.on('data', () => {});
    schedulerChild.stdin.on('error', () => {});
    schedulerChild.on('message', message => { if (message?.type === 'scheduler') schedulerHealth = message; });
    schedulerChild.once('spawn', () => schedulerChild.stdin.end(JSON.stringify({ config: executionConfig(config) })));
    schedulerChild.once('error', () => { schedulerHealth = { ...schedulerHealth, running: false, error: 'scheduler_launch_failed' }; });
    schedulerChild.once('close', () => {
      schedulerHealth = { ...schedulerHealth, running: false };
      if (!closing) schedulerRestart = setTimeout(launchScheduler, Math.max(1000, config.poll_interval_ms));
    });
  };
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    try {
      const address = server.address();
      const base = `http://127.0.0.1:${address.port}`;
      const url = new URL(req.url, base);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const guardRequest = new Request(url, { headers });
      const rejected = hostHeaderValidationResponse(guardRequest, ['127.0.0.1', 'localhost']) ?? originValidationResponse(guardRequest, ['127.0.0.1', 'localhost']);
      if (rejected) { await writeResponse(res, rejected); return; }
      const origins = [base, `http://localhost:${address.port}`];
      if (url.origin !== base || (req.headers.origin && !origins.includes(req.headers.origin))) {
        await writeResponse(res, Response.json({ error: 'service_origin_denied' }, { status: 403 })); return;
      }
      if (!tokenMatches(req.headers.authorization, token)) {
        await writeResponse(res, Response.json({ error: 'service_authentication_required' }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="uagents"' } })); return;
      }
      if (url.pathname === '/health' && req.method === 'GET') {
        await writeResponse(res, Response.json(ok({ service: 'uagents', protocol: '1.0', started_at_ms: started, scheduler: schedulerHealth, tools: runner.snapshot?.() ?? null }))); return;
      }
      if (url.pathname !== '/mcp') { await writeResponse(res, Response.json({ error: 'not_found' }, { status: 404 })); return; }
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req, config.max_request_bytes);
      const request = new Request(url, { method: req.method, headers, body, signal: abort.signal });
      const response = await handler.fetch(request);
      await writeResponse(res, response);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) await writeResponse(res, Response.json(notOk(error), { status: error.code === 'service_request_too_large' ? 413 : 500 }));
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  if (scheduler) launchScheduler();
  return {
    server, config, url: `http://127.0.0.1:${server.address().port}/mcp`,
    health: () => ({ scheduler: schedulerHealth, tools: runner.snapshot?.() }),
    close() {
      closePromise ??= (async () => {
        closing = true; clearTimeout(schedulerRestart);
        const child = schedulerChild;
        const stopped = child && child.exitCode === null && child.signalCode === null
          ? new Promise(resolve => {
            const timer = setTimeout(() => { try { child.kill(); } catch {} }, 5000);
            child.once('close', () => { clearTimeout(timer); resolve(); });
            if (child.connected) child.send({ type: 'stop' }, () => {});
            else { try { child.kill(); } catch {} }
          }) : Promise.resolve();
        await handler.close();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        await stopped;
      })();
      return closePromise;
    },
  };
}

async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) fail('service_request_too_large', 'Service request exceeds its byte limit.');
  return new Promise((resolve, reject) => {
    let bytes = 0; const chunks = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const error = () => { cleanup(); reject(new Error('Request stream failed.')); };
    const aborted = () => { cleanup(); reject(new Error('Request stream closed.')); };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > limit) {
        cleanup(); req.resume();
        try { fail('service_request_too_large', 'Service request exceeds its byte limit.'); } catch (failure) { reject(failure); }
      } else chunks.push(chunk);
    };
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}

async function writeResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) await pipeline(Readable.fromWeb(response.body), res);
  else res.end();
}

export async function main(argv = process.argv.slice(2), io = console) {
  try {
    if (argv[0] === '--tool-child') { await runToolChild(); return 0; }
    if (argv[0] === '--scheduler-child') { await runSchedulerChild(entry); return 0; }
    if (argv[0] === '--task-worker') { await runRegisteredTask(argv[1], argv[2]); return 0; }
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      config: { type: 'string' }, workspace: { type: 'string', multiple: true }, target: { type: 'string', multiple: true },
      'state-dir': { type: 'string' }, 'registry-config': { type: 'string' }, port: { type: 'string' },
      help: { type: 'boolean' },
    } });
    const [command, ...extra] = positionals;
    if (values.help || (command === 'describe' && !extra.length)) {
      io.log(JSON.stringify(ok({ schema_version: '1.0', transport: 'streamable-http',
        commands: {
          init: { syntax: 'init --config FILE [--workspace ROOT ...] [--target TARGET ...] [--state-dir DIR] [--registry-config FILE] [--port PORT]', effect: 'Create private configuration and credential; refuse replacement.' },
          serve: { syntax: 'serve --config FILE', effect: 'Run loopback MCP and queue scheduler in the current user session.' },
          health: { syntax: 'health --config FILE', effect: 'Read authenticated service health.' },
          describe: { syntax: 'describe', effect: 'Describe service commands without starting the Core.' },
          schema: { syntax: 'schema config', effect: 'Return the configuration schema.' },
        }, config_schema: SERVICE_CONFIG_SCHEMA,
      }))); return 0;
    }
    if (command === 'schema' && extra.length === 1 && extra[0] === 'config') { io.log(JSON.stringify(ok(SERVICE_CONFIG_SCHEMA))); return 0; }
    if (!values.config || extra.length) fail('usage', 'Use init|serve|health --config <absolute-file>.');
    if (command === 'init') {
      const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'uAgents') : path.dirname(values.config);
      const config = await initializeServiceConfig(values.config, {
        schema_version: '1.0', port: Number(values.port ?? 4319),
        state_dir: values['state-dir'] ?? path.join(base, 'v1'),
        token_file: path.join(path.dirname(values.config), 'service-token'),
        workspace_roots: values.workspace ?? [process.cwd()],
        targets: values.target ?? ['agy', 'codex', 'claudeCode', 'workbuddy', 'dsh', 'opencode', 'doubao', 'trae'],
        registry_config: values['registry-config'] ?? null,
      });
      const checkin = await bootstrapServiceCheckin(config);
      io.log(JSON.stringify(ok({ config_file: path.resolve(values.config), endpoint: `http://127.0.0.1:${config.port}/mcp`, token_file: config.token_file, checkin }))); return 0;
    }
    const config = readServiceConfig(values.config);
    await verifyServiceFiles(values.config, config.token_file);
    if (command === 'health') {
      const response = await fetch(`http://127.0.0.1:${config.port}/health`, { headers: { Authorization: `Bearer ${readServiceToken(config.token_file)}` }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) fail('service_unavailable', 'Service health request failed.');
      io.log(JSON.stringify(await response.json())); return 0;
    }
    if (command !== 'serve') fail('usage', 'Use init|serve|health --config <absolute-file>.');
    const service = await createLocalService({ config });
    void bootstrapServiceCheckin(config).then(result => {
      if (result.status === 'failed') process.stderr.write(`uagents check-in: ${result.reason}\n`);
    });
    io.log(JSON.stringify(ok({ endpoint: service.url, config_file: path.resolve(values.config) })));
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await service.close(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return 0;
  } catch (error) { io.log(JSON.stringify(notOk(error))); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === entry) process.exitCode = await main();
