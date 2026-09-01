import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { TraeTaskService } from './service.mjs';

const expose = value => value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'digest'))
  : value;
const response = value => {
  const visible = expose(value);
  return { content: [{ type: 'text', text: JSON.stringify(visible) }], structuredContent: visible };
};
const error = reason => ({
  content: [{ type: 'text', text: JSON.stringify({ error: reason.code ?? 'internal_error', message: reason.message }) }],
  isError: true,
  structuredContent: { error: reason.code ?? 'internal_error', message: reason.message },
});
const invoke = handler => async input => { try { return response(await handler(input)); } catch (reason) { return error(reason); } };

serveStdio(() => {
  const service = new TraeTaskService();
  const server = new McpServer({ name: 'uagents-trae-cn', version: '0.1.0-alpha.1' }, { capabilities: { tools: {} } });
  server.registerTool('trae_probe', {
    description: 'Check the explicit local TRAE CN gateway and dedicated CDP window without launching TRAE or sending a task.',
    inputSchema: z.object({}),
  }, invoke(() => service.probe()));
  server.registerTool('trae_submit', {
    description: 'Submit one tracked task to a fresh TRAE CN Solo conversation through the local gateway. Returns after a stable native task ID is accepted.',
    inputSchema: z.object({
      request_id: z.uuid(),
      prompt: z.string().min(1).max(65536),
      workspace: z.string().optional(),
      timeout_ms: z.number().int().min(10000).max(7200000).optional(),
    }),
  }, invoke(input => service.submit(input)));
  server.registerTool('trae_status', {
    description: 'Inspect one previously submitted TRAE task by its stored native task identity. Unknown tasks are never replayed.',
    inputSchema: z.object({ request_id: z.uuid() }),
  }, invoke(input => service.status(input.request_id)));
  server.registerTool('trae_result', {
    description: 'Return the final response and completion evidence for one owned TRAE task when available.',
    inputSchema: z.object({ request_id: z.uuid() }),
  }, invoke(input => service.result(input.request_id)));
  return server;
}, { onerror: reason => process.stderr.write(`uagents trae mcp: ${reason.message}\n`) });
