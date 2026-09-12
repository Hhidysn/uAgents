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
const councilIdSchema = z.object({ council_id: z.uuid() }).strict();
const councilAdoptSchema = z.object({
  council_id: z.uuid(),
  member_id: z.string().min(1).max(64),
  workspace: z.string().min(1),
}).strict();
const councilCleanupSchema = z.object({
  council_id: z.uuid(),
  member_id: z.string().min(1).max(64).optional(),
  all: z.boolean().optional(),
  force: z.boolean().optional(),
}).strict().refine(value => Boolean(value.member_id) !== Boolean(value.all), {
  message: 'Council cleanup requires exactly one of member_id or all=true.',
});
export const councilValidationSchema = z.object({
  schema_version: z.literal('1.0'),
  command: z.array(z.string().min(1).max(4096)).min(1).max(64),
  timeout_ms: z.number().int().min(100).max(3_600_000).optional(),
}).strict();
const councilValidateSchema = z.object({
  council_id: z.uuid(),
  member_id: z.string().min(1).max(64).optional(),
  all: z.boolean().optional(),
  validation: councilValidationSchema,
}).strict().refine(value => Boolean(value.member_id) !== Boolean(value.all), {
  message: 'Council validation requires exactly one of member_id or all=true.',
});
const attachmentInputSchema = z.object({
  type: z.enum(['file', 'image']),
  path: z.string().optional(),
  source: z.string().optional(),
  blob: z.object({
    name: z.string().min(1).max(255),
    data_base64: z.string().max(44_739_244),
  }).strict().optional(),
}).strict().refine(input => Number(input.path !== undefined) + Number(input.source !== undefined) + Number(input.blob !== undefined) === 1, {
  message: 'Attachment input must contain exactly one of path, source, or blob.',
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

export const councilRequestSchema = z.object({
  schema_version: z.literal('1.0'),
  council_id: z.uuid(),
  strategy: z.literal('fanout').optional(),
  mode: z.enum(['analysis', 'implementation']).optional(),
  workspace_strategy: z.enum(['shared', 'git-worktree']).optional(),
  prompt: z.string().min(1).max(65_536),
  workspace: z.string().optional(),
  inputs: z.array(attachmentInputSchema).max(64).optional(),
  execution: z.object({
    observation_timeout_ms: z.number().int().optional(),
    effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
    permission: z.enum(['native', 'advisory-read-only', 'enforced-read-only', 'workspace-write', 'full-access']).optional(),
  }).strict().optional(),
  members: z.array(z.object({
    member_id: z.string().min(1).max(64),
    target: z.string().min(1).max(64),
    model: z.string().min(1).max(256),
    instruction: z.string().min(1).max(65_536).optional(),
    session: z.object({
      continue_from_task_id: z.uuid().optional(),
      fork_from_task_id: z.uuid().optional(),
    }).strict().refine(value => Boolean(value.continue_from_task_id) !== Boolean(value.fork_from_task_id), {
      message: 'Session must contain exactly one of continue_from_task_id or fork_from_task_id.',
    }).optional(),
  }).strict()).min(2).max(16),
}).strict().refine(value => value.mode !== 'implementation' || value.workspace_strategy === 'git-worktree', {
  message: 'implementation Council requires workspace_strategy=git-worktree.',
}).refine(value => value.workspace_strategy !== 'git-worktree' || Boolean(value.workspace), {
  message: 'git-worktree Council requires workspace.',
});

export function createToolHandlers(runtime) {
  return {
    uagents_list_targets: async () => runtime.listTargets(),
    uagents_get_capabilities: async input => runtime.capabilities(input.target),
    uagents_list_models: async input => runtime.listModels(input.target),
    uagents_probe: async input => runtime.probe(input.target, { model: input.model ?? 'default' }),
    uagents_submit: async input => runtime.submit(input),
    uagents_council_submit: async input => runtime.submitCouncil(input),
    uagents_council_status: async input => runtime.councilStatus(input.council_id),
    uagents_council_result: async input => runtime.councilResult(input.council_id),
    uagents_council_diff: async input => runtime.councilDiff(input.council_id),
    uagents_council_adopt: async input => runtime.councilAdopt(input.council_id, { memberId: input.member_id, workspace: input.workspace }),
    uagents_council_validate: async input => runtime.councilValidate(input.council_id, { memberId: input.member_id ?? null, all: input.all === true, validation: input.validation }),
    uagents_council_cleanup: async input => runtime.councilCleanup(input.council_id, { memberId: input.member_id ?? null, all: input.all === true, force: input.force === true }),
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
  register('uagents_list_models', 'Merge approved model routes with local no-prompt native model discovery. Discovery never auto-approves new models and does not validate provider authentication, quota, or live availability.', z.object({ target: z.string().min(1).max(64), refresh: z.boolean().optional() }).strict());
  register('uagents_probe', 'Check one target connection without submitting a task, launching an app, logging in, or approving anything.', z.object({ target: z.string().min(1).max(64), model: z.string().min(1).max(256).optional() }).strict());
  register('uagents_submit', 'Register one idempotent task and return quickly with a task ID and polling interval. Execution continues in a detached worker.', requestSchema);
  register('uagents_council_submit', 'Register a fan-out Council. Shared mode preserves the original workspace; git-worktree creates one persistent branch/worktree per member and enables implementation Council. No automatic merge, vote or synthesis is performed.', councilRequestSchema);
  register('uagents_council_status', 'Aggregate persisted member Task status for one Council. Never contacts native Agents.', councilIdSchema);
  register('uagents_council_result', 'Aggregate member Task results, usage and artifacts for one Council without model synthesis.', councilIdSchema);
  register('uagents_council_diff', 'Compare git-worktree Council candidates locally, including tracked patches and untracked files. Never modifies a worktree or contacts native Agents.', councilIdSchema);
  register('uagents_council_adopt', 'Apply one explicitly selected git-worktree Council candidate to a destination Git workspace. The destination HEAD must match the Council base HEAD. Never commits, merges, selects a winner, or contacts native Agents.', councilAdoptSchema);
  register('uagents_council_validate', 'Run one explicit local argv validation in selected git-worktree Council candidate workspaces and persist exit/output evidence. Never invokes a shell, contacts native Agents, or selects a winner.', councilValidateSchema);
  register('uagents_council_cleanup', 'Explicitly remove selected Council worktrees and dedicated branches while preserving Council and Task history. Dirty or diverged candidates require force=true.', councilCleanupSchema);
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
