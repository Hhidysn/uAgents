import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { ToolRunner } from '../plugins/uagents/src/service/tool-runner.mjs';

function serviceConfig(overrides = {}) {
  const stateRoot = path.resolve('.local', 'test-runs', 'service-tool-runner');
  return {
    state_dir: stateRoot, token_file: path.join(stateRoot, 'token'), registry_config: null,
    targets: ['agy'], workspace_roots: [], tools: ['uagents_status'],
    max_tool_children: 1, max_request_bytes: 1024, tool_timeout_ms: 30, ...overrides,
  };
}

class ControlledChild extends EventEmitter {
  constructor({ inputError = false } = {}) {
    super();
    this.killCalls = 0;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new EventEmitter();
    this.stdin.end = () => {
      if (inputError) setImmediate(() => this.stdin.emit('error', new Error('fixture stdin failure')));
    };
  }
  kill() { this.killCalls++; return false; }
  start() { setImmediate(() => this.emit('spawn')); }
  close() { this.emit('close', null); }
}

test('timed-out tool retains capacity when kill fails until the child closes', async () => {
  const child = new ControlledChild();
  const runner = new ToolRunner({ config: serviceConfig(), entry: 'fixture-tool-child', spawnImpl: () => child });
  const invocation = runner.invoke('uagents_status', { task_id: 'fixture' });
  child.start();
  try {
    await assert.rejects(invocation, { code: 'service_tool_timeout', submission: 'may_have_been_sent' });
    assert.equal(child.killCalls, 1);
    assert.equal(runner.snapshot().in_flight, 1);
    assert.throws(() => runner.invoke('uagents_status', { task_id: 'second' }), { code: 'service_busy' });
  } finally {
    child.close();
  }
  assert.equal(runner.snapshot().in_flight, 0);
});

test('stdin error kills the child and retains capacity until its close event', async () => {
  const child = new ControlledChild({ inputError: true });
  const runner = new ToolRunner({ config: serviceConfig({ tool_timeout_ms: 2_000 }), entry: 'fixture-tool-child', spawnImpl: () => child });
  const invocation = runner.invoke('uagents_status', { task_id: 'fixture' });
  child.start();
  try {
    await assert.rejects(invocation, { code: 'service_tool_input_failed', submission: 'may_have_been_sent' });
    assert.equal(child.killCalls, 1);
    assert.equal(runner.snapshot().in_flight, 1);
    assert.throws(() => runner.invoke('uagents_status', { task_id: 'second' }), { code: 'service_busy' });
  } finally {
    child.close();
  }
  assert.equal(runner.snapshot().in_flight, 0);
});
