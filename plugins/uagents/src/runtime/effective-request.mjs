import { canonicalHash } from '../protocol/canonical-json.mjs';
import { fail } from '../protocol/errors.mjs';
import { parseRequest } from '../protocol/schema.mjs';
import { ATTACHMENT_LIMITS, attachmentSnapshot, snapshotMatches } from '../artifacts/attachments.mjs';
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
    session: request.session,
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
  const snapshots = inputs.map(input => attachmentSnapshot(workspace, input));
  const totalBytes = snapshots.reduce((total, snapshot) => total + snapshot.size_bytes, 0);
  if (totalBytes > ATTACHMENT_LIMITS.total_bytes) {
    fail('invalid_input', `Declared inputs exceed ${ATTACHMENT_LIMITS.total_bytes} total bytes.`);
  }
  return snapshots;
}

export function verifyInputSnapshots(workspace, snapshots) {
  const current = snapshotInputs(workspace, snapshots.map(({ type, path: inputPath }) => ({ type, path: inputPath })));
  // Older Schema 1.0 snapshots contained fewer metadata fields. Compare every
  // persisted field against the richer current snapshot so recovery remains
  // backward compatible without weakening newly registered evidence.
  if (!snapshots.every((snapshot, index) => snapshotMatches(current[index], snapshot))) {
    fail('input_changed', 'An input changed after task registration.', { category: 'conflict', submission: 'not_sent' });
  }
  return true;
}
