import path from 'node:path';
import { verifiedNativeInputs } from '../artifacts/attachments.mjs';

export function buildWorkBuddyArgs(request) {
  if (request.kind === 'probe') return ['--version'];
  const advisoryReadOnly = request.permission_policy === 'advisory-read-only';
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    ...(request.fork_session_id
      ? ['--resume', request.fork_session_id, '--fork-session']
      : request.continue_session_id
        ? ['--resume', request.continue_session_id]
        : ['--session-id', request.request_id]),
    '--max-turns', '6',
    ...(typeof request.model_resolved === 'string' && request.model_resolved ? ['--model', request.model_resolved] : []),
    ...(request.mode === 'implementation' && !advisoryReadOnly ? ['--permission-mode', 'acceptEdits'] : []),
  ];
}

export function buildWorkBuddyInput(request, workspace, snapshots = []) {
  const inputs = request.inputs ?? [];
  const attachments = verifiedNativeInputs(workspace, inputs, snapshots);
  const content = [{ type: 'text', text: buildWorkBuddyPrompt(request, workspace) }];
  for (const [index, input] of inputs.entries()) {
    const attachment = attachments[index];
    const data = attachment.bytes.toString('base64');
    if (input.type === 'image') {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: attachment.media_type, data },
        original_filename: path.basename(input.path),
      });
    } else {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: attachment.media_type, data },
      });
    }
  }
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

export function buildWorkBuddyPrompt(request, workspace) {
  return `uAgents task workspace: ${workspace}\nMode: ${request.mode}. Expected files: ${JSON.stringify(request.expected_outputs)}\nWork only on this task. Do not delegate or start background work. You are not alone; do not revert others' edits.\n\n${request.prompt}`;
}
