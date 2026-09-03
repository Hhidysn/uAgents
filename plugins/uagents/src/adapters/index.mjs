import { AgyAdapter } from './agy/adapter.mjs';
import { OpenCodeAdapter } from './opencode/adapter.mjs';
import { WorkBuddyAdapter } from './workbuddy/adapter.mjs';
import { fail } from '../protocol/errors.mjs';

export function adapterFor(target, options) {
  if (target === 'agy') return new AgyAdapter(options);
  if (target === 'workbuddy') return new WorkBuddyAdapter(options);
  if (target === 'opencode') return new OpenCodeAdapter(options);
  fail('unsupported_capability', `Target adapter is not migrated yet: ${target}`, { submission: 'not_sent' });
}
