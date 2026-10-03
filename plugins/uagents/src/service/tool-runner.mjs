import { spawn } from 'node:child_process';
import { fail, UAgentsError } from '../protocol/errors.mjs';
import { serviceChildEnvironment, executionConfig } from './config.mjs';

// Each invocation owns only an observer/tool process. Task workers are detached.
export class ToolRunner {
  constructor({ config, entry, spawnImpl = spawn }) {
    this.config = config; this.entry = entry; this.spawnImpl = spawnImpl; this.active = new Set(); this.unconfirmed = new Set();
  }

  invoke(name, input) {
    if (this.active.size >= this.config.max_tool_children) fail('service_busy', 'Service tool capacity is busy; query the existing task before retrying.', { category: 'runtime', retryable: true });
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnImpl(process.execPath, [this.entry, '--tool-child'], {
          windowsHide: true, env: serviceChildEnvironment(this.config), stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { reject(failure('service_tool_launch_failed', false)); return; }
      this.active.add(child);
      const chunks = [];
      let bytes = 0, entered = false, finished = false;
      const done = (error, value) => {
        if (finished) return;
        finished = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const abort = code => {
        if (finished) return;
        this.unconfirmed.add(child);
        try { child.kill(); } catch { /* Retain capacity until close confirms termination. */ }
        done(failure(code, entered));
      };
      const timer = setTimeout(() => abort('service_tool_timeout'), this.config.tool_timeout_ms);
      child.stderr.on('data', () => {}); // Native/diagnostic text is never copied to HTTP or service logs.
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > this.config.max_request_bytes * 2) { abort('service_tool_output_limit'); return; }
        chunks.push(chunk);
      });
      child.once('error', () => {
        if (entered) abort('service_tool_process_failed');
        else done(failure('service_tool_launch_failed', false));
      });
      child.stdin.on('error', () => abort('service_tool_input_failed'));
      child.once('spawn', () => {
        entered = true;
        child.stdin.end(JSON.stringify({ config: executionConfig(this.config), name, input }));
      });
      child.once('close', code => {
        this.active.delete(child); this.unconfirmed.delete(child);
        if (finished) return;
        try {
          const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (code !== 0 || typeof envelope.ok !== 'boolean') throw new Error();
          if (!envelope.ok) {
            const error = envelope.error;
            done(new UAgentsError(error.code, error.message, error));
          } else done(null, envelope.data);
        } catch { done(failure('service_tool_response_invalid', entered)); }
      });
    });
  }

  snapshot() { return { in_flight: this.active.size, limit: this.config.max_tool_children, unconfirmed_exit: this.unconfirmed.size }; }
}

function failure(code, entered) {
  return new UAgentsError(code, 'The service operation could not be confirmed. Query the original task before any retry.', {
    category: 'transport', submission: entered ? 'may_have_been_sent' : 'not_sent',
  });
}
