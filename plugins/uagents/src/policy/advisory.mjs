const ADVISORY_READ_ONLY_INSTRUCTION = [
  'Permission policy: advisory-read-only (advisory guidance, not an enforced sandbox).',
  'Only inspect and analyze the workspace, then return recommendations.',
  'Do not edit, create, delete, rename, or overwrite files.',
  'Do not run commands that write to, mutate, or delete workspace state.',
  'Describe any proposed changes without applying them.',
].join('\n');

export function advisoryPrompt(request) {
  if (request?.execution?.permission !== 'advisory-read-only') return request.prompt;
  return `${request.prompt}\n\n${ADVISORY_READ_ONLY_INSTRUCTION}`;
}
