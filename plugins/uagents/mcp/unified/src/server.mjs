import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { notOk, ok } from '../../../src/protocol/envelope.mjs';
import { resolveStateRoot, UnifiedRuntime } from '../../../src/runtime/api.mjs';
import { runRegisteredTask } from '../../../src/runtime/worker-factory.mjs';
import { childEnvironment } from '../../../src/runtime/child-environment.mjs';

const taskIdSchema = z.object({ task_id: z.uuid() }).strict();
const attachmentInputSchema = z.object({
  type: z.enum(['file', 'image']),
  path: z.string().optional(),
  source: z.string().optional(),
}).strict().refine(input => Boolean(input.path) !== Boolean(input.source), {
  message: 'Attachment input must contain exactly one of path or source.',
});
export const requestSchema = z.object({
  schema_version: z.literal('1.0'),
  request_id: z.uuid(),
  target: z.string().min(1).max(64),
  model: z.string().min(1).max(256),
  mode: z.enum(['analysis', 'implementation']),
  prompt: z.string().min(1).max(65_536),
  workspace: z.string().optional(),
  session: z.object({
    continue_from_task_id: z.uuid().optional(),
    fork_from_task_id: z.uuid().optional(),
  }).strict().refine(value => Boolean(value.continue_from_task_id) !== Boolean(value.fork_from_task_id), {
    message: 'Session must contain exactly one of continue_from_task_id or fork_from_task_id.',
  }).optional(),
  inputs: z.array(attachmentInputSchema).max(64).optional(),
  expected_outputs: z.array(z.object({
    path: z.string(), type: z.literal('file'), required: z.boolean().optional(), max_bytes: z.number().int().positive().optional(),
  }).strict()).max(64).optional(),
  execution: z.object({
    observation_timeout_ms: z.number().int().optional(), execution_timeout_ms: z.number().int().nullable().optional(),
    effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
    permission: z.enum(['native', 'advisory-read-only', 'enforced-read-only', 'workspace-write', 'full-access']).optional(),
    native_args: z.array(z.string().min(1).max(4_096)).max(64).optional(),
  }).strict().optional(),
  policy: z.object({ fallback: z.string().optional(), max_cost_usd: z.number().nonnegative().nullable().optional() }).strict().optional(),
}).strict();

export function createToolHandlers(runtime) {
  return {
    uagents_list_targets: async () => runtime.listTargets(),
    uagents_get_capabilities: async input => runtime.capabilities(input.target),
    uagents_list_models: async input => runtime.listModels(input.target),
    uagents_probe: async input => runtime.probe(input.target, { model: input.model ?? 'default' }),
    uagents_submit: async input => runtime.submit(input),
    uagents_status: async input => runtime.status(input.task_id),
    uagents_result: async input => runtime.result(input.task_id),
    uagents_cancel: async input => runtime.cancel(input.task_id),
    uagents_list_tasks: async input => runtime.listTasks({ cursor: input.cursor ?? null, limit: input.limit ?? 50 }),
    uagents_reconcile: async input => runtime.reconcile(input.task_id),
    uagents_ensure: async input => runtime.ensure(input.target, { refresh: input.refresh === true }),
    uagents_resume: async input => runtime.resume(input.task_id),
    uagents_stop: async input => runtime.stop(input.target),
  };
}

export function createServer({ runtime = createRuntime(), supervisor = null } = {}) {
  // The shared host supervisor is injected by start(); hosts constructing the
  // server directly (tests) keep null and lifecycle tools degrade to a
  // structured unsupported error.
  if (supervisor) runtime.supervisor = supervisor;
  const handlers = createToolHandlers(runtime);
  const server = new McpServer({ name: 'uagents-unified', version: '0.2.0-alpha.1' }, { capabilities: { tools: {} } });
  const register = (name, description, inputSchema) => server.registerTool(name, { description, inputSchema }, invoke(handlers[name]));
  register('uagents_list_targets', 'List enabled Agent targets from the static registry. Does not contact providers.', z.object({}).strict());
  register('uagents_get_capabilities', 'Return the declared capabilities of one Agent target.', z.object({ target: z.string().min(1).max(64) }).strict());
  register('uagents_list_models', 'List approved model routes for one target. Does not validate provider availability.', z.object({ target: z.string().min(1).max(64), refresh: z.boolean().optional() }).strict());
  register('uagents_probe', 'Check one target connection without submitting a task, launching an app, logging in, or approving anything.', z.object({ target: z.string().min(1).max(64), model: z.string().min(1).max(256).optional() }).strict());
  register('uagents_submit', 'Register one idempotent task and return quickly with a task ID and polling interval. Execution continues in a detached worker.', requestSchema);
  register('uagents_status', 'Read the persisted task status only. This tool never contacts the native Agent.', taskIdSchema);
  register('uagents_result', 'Read the persisted result, model identity, usage and captured artifact summary.', taskIdSchema);
  register('uagents_cancel', 'Persist a cancellation request. Remote cancellation is confirmed only when the target can prove it.', taskIdSchema);
  register('uagents_list_tasks', 'List persisted tasks using cursor pagination. The hard maximum page size is 200.', z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }).strict());
  register('uagents_reconcile', 'Explicitly contact the native target for the stored native identity and refine an indeterminate or waiting task. Never resubmits.', taskIdSchema);
  register('uagents_ensure', 'Discover, verify and cache the target installation; for desktop targets start or reuse the dedicated managed instance. Never sends a prompt.', z.object({ target: z.string().min(1).max(64), refresh: z.boolean().optional() }).strict());
  register('uagents_resume', 'Resume an abandoned unsent task or first-login wait on the same attempt, or reconcile a waiting native task. Never creates a new attempt.', taskIdSchema);
  register('uagents_stop', 'Stop only the ownership-proven managed instance of one desktop target. Refuses unmanaged or user-owned processes.', z.object({ target: z.string().min(1).max(64) }).strict());
  return server;
}

function createRuntime() {
  const stateRoot = resolveStateRoot(process.env.UAGENTS_STATE_DIR);
  const bundledEntry = fileURLToPath(import.meta.url);
  return new UnifiedRuntime({
    stateRoot,
    spawnWorker: (root, taskId) => {
      const child = spawn(process.execPath, [bundledEntry, '--worker', root, taskId], {
        detached: true, windowsHide: true, env: childEnvironment(), stdio: 'ignore',
      });
      child.unref();
      return child;
    },
  });
}

function response(envelope) {
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope };
}

function invoke(handler) {
  return async input => {
    try { return response(ok(await handler(input))); }
    catch (error) { return { ...response(notOk(error)), isError: true }; }
  };
}

export async function start(argv = process.argv) {
  if (argv[2] === '--worker') {
    const [, , , stateRoot, taskId] = argv;
    if (!stateRoot || !taskId) throw new Error('Missing worker state root or task ID.');
    await runRegisteredTask(stateRoot, taskId);
    return;
  }
  // Same host control plane as the CLI and workers; best-effort, so a host
  // without a usable state dir still serves task tools and lifecycle tools
  // return a structured unsupported error.
  const { createHostSupervisor } = await import('../../../src/host/target-supervisor.mjs');
  const supervisor = await createHostSupervisor();
  serveStdio(() => createServer({ supervisor }), { onerror: error => process.stderr.write(`uagents unified mcp: ${error.message}\n`) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await start();
