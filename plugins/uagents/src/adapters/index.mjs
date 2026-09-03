import { AgyAdapter } from './agy/adapter.mjs';
import { DoubaoAdapter } from './doubao/adapter.mjs';
import { OpenCodeAdapter } from './opencode/adapter.mjs';
import { TraeAdapter } from './trae/adapter.mjs';
import { WorkBuddyAdapter } from './workbuddy/adapter.mjs';
import { fail } from '../protocol/errors.mjs';

export function adapterFor(target, options) {
  if (target === 'agy') return new AgyAdapter(options);
  if (target === 'doubao') return new DoubaoAdapter(options);
  if (target === 'workbuddy') return new WorkBuddyAdapter(options);
  if (target === 'opencode') return new OpenCodeAdapter(options);
  if (target === 'trae') return new TraeAdapter(options);
  fail('unsupported_capability', `Target adapter is not migrated yet: ${target}`, { submission: 'not_sent' });
}
