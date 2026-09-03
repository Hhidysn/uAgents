import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { cancel, result, submit } from './task.mjs';
import { fail, readJson, stateRoot, status } from './store.mjs';

try {
  const { values, positionals } = parseArgs({ options: {
    'state-dir': { type: 'string' }, request: { type: 'string' }, id: { type: 'string' }, target: { type: 'string' },
  }, allowPositionals: true });
  const [verb, ...extra] = positionals;
  if (extra.length || !['capabilities', 'probe', 'submit', 'status', 'result', 'cancel'].includes(verb)) fail('usage', 'Use capabilities | probe/submit --request FILE --state-dir ABS_PATH | status/result/cancel --id UUID --state-dir ABS_PATH.');
  if (verb === 'capabilities') {
    const target = values.target ?? 'agy';
    if (!['agy', 'workbuddy', 'opencode'].includes(target)) fail('unsupported_target', 'Supported: agy, workbuddy, opencode.');
    console.log(JSON.stringify({ target, maturity: 'native-permissions-preview', modes: target === 'opencode' ? ['analysis'] : ['analysis', 'implementation'],
      identity: target === 'agy' ? 'pre-send model/cwd handshake and matching native session' : target === 'workbuddy' ? 'caller-assigned native UUID and reported cwd after submission' : 'matching session and final message parts; selected model is not echoed by this stream',
      permission_policy: 'native', implementation: target !== 'opencode', hard_readonly: false, hard_path_isolation: false,
      edit_mode: target === 'opencode' ? 'inherited; no auto approval' : 'implementation enables native file edit mode; analysis inherits settings',
      models: target === 'workbuddy' ? ['workbuddy-default'] : target === 'opencode' ? ['commandcode-goat/deepseek/deepseek-v4-flash', 'commandcode-goat/z-ai/glm-5.3-flash'] : 'explicit Gemini slug',
      probe_scope: target === 'agy' ? 'preflight_only' : 'version_only',
      expected_output_check: true, skip_all_permissions: false, resume: false, native_cancel_confirmation: false,
      lifecycle: 'one detached worker per task; application-exit survival unverified', desktop_mcp: 'not implemented' }));
  } else {
    if (values.target) fail('usage', '--target is only used with capabilities; use target in the request JSON for submit/probe.');
    const starts = ['submit', 'probe'].includes(verb);
    if (starts ? (!values.request || values.id) : (!values.id || values.request)) fail('usage', 'Provide only the arguments required for this verb.');
    const root = stateRoot(values['state-dir'], starts);
    let output;
    if (starts) {
      if (fs.statSync(values.request).size > 70000) fail('invalid_request', 'Request file too large.');
      output = await submit(root, readJson(values.request), { kind: verb === 'probe' ? 'probe' : 'run' });
    } else if (verb === 'status') output = status(root, values.id);
    else if (verb === 'result') output = result(root, values.id);
    else output = cancel(root, values.id);
    console.log(JSON.stringify(output));
  }
} catch (error) {
  console.log(JSON.stringify({ status: 'error', error: error.code ?? 'invalid_input', message: error.code ? error.message : 'Unable to read or validate input; no task was intentionally resubmitted.' }));
  process.exitCode = 1;
}
