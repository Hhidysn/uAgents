import { readChildInput, executeServiceTool } from '../../src/service-child.mjs';
import { ok } from '../../../../src/protocol/envelope.mjs';

const { config, name, input } = await readChildInput();
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
const result = name === 'uagents_submit' ? await executeServiceTool(config, name, input) : {
  secret_in_environment: Object.keys(process.env).some(key => /^UAGENTS_(?:SERVICE_|TOKEN|ENDPOINT)/i.test(key)),
  config_contains_token_file: 'token_file' in config,
  unicode: '中文回传成功',
};
process.stdout.write(JSON.stringify(ok(result)));
