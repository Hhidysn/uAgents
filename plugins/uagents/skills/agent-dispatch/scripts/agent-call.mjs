import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { cancel, result, submit } from './task.mjs';
import { fail, readJson, stateRoot, status } from './store.mjs';

try {
  const { values, positionals } = parseArgs({ options: {
    'state-dir': { type: 'string' }, request: { type: 'string' }, id: { type: 'string' },
  }, allowPositionals: true });
  const [verb, ...extra] = positionals;
  if (extra.length || !['capabilities', 'probe', 'submit', 'status', 'result', 'cancel'].includes(verb)) fail('usage', 'Use capabilities | probe/submit --request FILE --state-dir ABS_PATH | status/result/cancel --id UUID --state-dir ABS_PATH.');
  if (verb === 'capabilities') {
    console.log(JSON.stringify({ target: 'agy', maturity: 'guarded-preview', mode: 'text-analysis',
      enforced_gate: 'native init must report zero tools and exact model/agent/workspace',
      implementation: false, file_access: false, resume: false, native_cancel_confirmation: false,
      lifecycle: 'one detached worker per task; application-exit survival unverified', other_targets: 'not implemented' }));
  } else {
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
