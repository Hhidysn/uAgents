import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalHash } from '../protocol/canonical-json.mjs';
import { fail } from '../protocol/errors.mjs';
import { parseRequest } from '../protocol/schema.mjs';
import { pathIsWithin } from '../path-containment.mjs';
import { canonicalWorkspace } from './workspace-key.mjs';

export function materializeEffectiveRequest(originalInput, evaluated, versions = {}) {
  const rawRequest = parseRequest(originalInput);
  const request = evaluated.request;
  const workspaceIdentity = request.workspace ? canonicalWorkspace(request.workspace) : null;
  const inputs = snapshotInputs(request.workspace, request.inputs);
  const effective = {
    schema_version: request.schema_version,
    request_id: request.request_id,
    target: request.target,
    mode: request.mode,
    prompt: request.prompt,
    workspace_identity: workspaceIdentity,
    inputs,
    expected_outputs: request.expected_outputs,
    execution: request.execution,
    policy: request.policy,
    model_resolved: request.model_resolved,
    provider: request.provider,
    route_id: request.route_id,
    registry_version: request.model_resolution.registry_version,
    policy_version: versions.policy_version ?? 'policy-1.0',
    adapter_version: versions.adapter_version ?? null,
  };
  return { raw_request_hash: canonicalHash(rawRequest), effective_request_hash: canonicalHash(effective), effective_request: effective, input_snapshots: inputs };
}

export function snapshotInputs(workspace, inputs) {
  if (!inputs.length) return [];
  const root = canonicalWorkspace(workspace);
  return inputs.map(input => {
    const candidate = path.resolve(workspace, input.path);
    let real;
    try { real = fs.realpathSync.native(candidate); }
    catch (error) { fail('invalid_input', `Input cannot be read: ${input.path}`, { details: { cause: error.code } }); }
    const normalized = process.platform === 'win32' ? real.normalize('NFC').toLocaleLowerCase('en-US') : real.normalize('NFC');
    if (!pathIsWithin(root, normalized)) fail('invalid_input', `Input resolves outside workspace: ${input.path}`);
    const info = fs.statSync(real);
    if (!info.isFile()) fail('invalid_input', `Input is not a file: ${input.path}`);
    const sha256 = createHash('sha256').update(fs.readFileSync(real)).digest('hex');
    return { type: 'file', path: input.path, size_bytes: info.size, sha256 };
  });
}

export function verifyInputSnapshots(workspace, snapshots) {
  const current = snapshotInputs(workspace, snapshots.map(({ type, path: inputPath }) => ({ type, path: inputPath })));
  if (canonicalHash(current) !== canonicalHash(snapshots)) fail('input_changed', 'An input changed after task registration.', { category: 'conflict', submission: 'not_sent' });
  return true;
}
