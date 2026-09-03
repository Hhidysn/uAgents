import { fail } from '../protocol/errors.mjs';

const KEY_BY_PERMISSION = {
  native: 'native',
  'advisory-read-only': 'advisory_read_only',
  'enforced-read-only': 'enforced_read_only',
  'workspace-write': 'workspace_write',
  'full-access': 'full_access',
};

export function requirePermission(descriptor, permission) {
  const key = KEY_BY_PERMISSION[permission];
  if (!key || descriptor.permissions?.[key] !== true) {
    fail('unsupported_capability', `Target does not enforce permission: ${permission}`, { category: 'policy', submission: 'not_sent' });
  }
  return permission;
}
