import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.mjs';
import { readServiceConfig, readServiceToken, verifyServiceFiles } from '../../../src/service/config.mjs';
import { UAgentsError, fail } from '../../../src/protocol/errors.mjs';
import { notOk } from '../../../src/protocol/envelope.mjs';

export async function connectService({ endpoint, tokenFile, timeoutMs = 300000 }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) {
    fail('invalid_request', 'Bridge endpoint must be http://127.0.0.1:<port>/mcp.');
  }
  const token = readServiceToken(tokenFile);
  const client = new Client({ name: 'uagents-stdio-bridge', version: '0.2.0-alpha.1' });
  // Redirects must never forward this credential to a different endpoint.
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const handlers = Object.fromEntries(listed.tools.map(tool => [tool.name, async input => {
      let result;
      try {
        result = await client.callTool({ name: tool.name, arguments: input }, { timeout: timeoutMs });
      } catch { throw unconfirmedResponse(); }
      return decodeServiceResult(result);
    }]));
    return { client, handlers, tools: listed.tools.map(tool => tool.name), close: () => client.close() };
  } catch (error) { await client.close(); throw error; }
}

export function decodeServiceResult(result) {
  let envelope;
  try {
    envelope = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text')?.text ?? 'null');
    if (!envelope || typeof envelope.ok !== 'boolean' || (envelope.ok && !Object.hasOwn(envelope, 'data'))) throw new Error();
    if (!envelope.ok) {
      const error = envelope.error;
      if (!error || typeof error.code !== 'string' || !error.code || typeof error.message !== 'string' ||
          typeof error.category !== 'string' || typeof error.retryable !== 'boolean' || error.schema_version !== '1.0' ||
          !['not_sent', 'may_have_been_sent', 'sent'].includes(error.submission)) throw new Error();
    }
  } catch { throw unconfirmedResponse(); }
  if (!envelope.ok) throw new UAgentsError(envelope.error.code, envelope.error.message, envelope.error);
  return envelope.data;
}

function unconfirmedResponse() {
  return new UAgentsError('service_tool_response_unconfirmed', 'The service response could not be confirmed. Query the original task before any retry.', {
    category: 'transport', submission: 'may_have_been_sent',
  });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: {
      config: { type: 'string' }, endpoint: { type: 'string' }, 'token-file': { type: 'string' },
    } });
    if (positionals.length || Boolean(values.config) === Boolean(values.endpoint)) fail('usage', 'Use --config FILE or --endpoint URL --token-file FILE.');
    const config = values.config ? readServiceConfig(values.config) : null;
    await verifyServiceFiles(values.config, config?.token_file ?? values['token-file']);
    const connection = await connectService({
      endpoint: config ? `http://127.0.0.1:${config.port}/mcp` : values.endpoint,
      tokenFile: config?.token_file ?? values['token-file'], timeoutMs: config?.tool_timeout_ms ?? 300000,
    });
    serveStdio(() => createServer({ handlers: connection.handlers, enabledTools: connection.tools }), {
      onerror: () => process.stderr.write('uagents bridge: connection failed; query the original task before retrying.\n'),
    });
    process.stdin.once('end', () => { void connection.close(); });
    return 0;
  } catch (error) { process.stderr.write(`${JSON.stringify(notOk(error))}\n`); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
