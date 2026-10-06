import { fail } from '../protocol/errors.mjs';

// Target adapters load on demand. The two desktop targets pull in the bundled
// CDP client and TRAE gateway client, so a machine that never dispatches to
// them must not load that code at all. Keep this the only place that maps a
// target to its adapter module.
const ADAPTER_LOADERS = {
  agy: async () => (await import('./agy/adapter.mjs')).AgyAdapter,
  claudeCode: async () => (await import('./claude-code/adapter.mjs')).ClaudeCodeAdapter,
  codex: async () => (await import('./codex/adapter.mjs')).CodexAdapter,
  doubao: async () => (await import('./doubao/adapter.mjs')).DoubaoAdapter,
  dsh: async () => (await import('./dsh/adapter.mjs')).DshAdapter,
  opencode: async () => (await import('./opencode/adapter.mjs')).OpenCodeAdapter,
  pi: async () => (await import('./pi/adapter.mjs')).PiAdapter,
  trae: async () => (await import('./trae/adapter.mjs')).TraeAdapter,
  workbuddy: async () => (await import('./workbuddy/adapter.mjs')).WorkBuddyAdapter,
};

export async function adapterFor(target, options) {
  const load = Object.hasOwn(ADAPTER_LOADERS, target) ? ADAPTER_LOADERS[target] : null;
  if (!load) fail('unsupported_capability', `Target adapter is not migrated yet: ${target}`, { submission: 'not_sent' });
  let Adapter;
  try {
    Adapter = await load();
  } catch (error) {
    // A partial installation must name the unavailable target instead of
    // surfacing a bare internal error.
    fail('unsupported_capability', `Target adapter is unavailable in this installation: ${target}`, {
      submission: 'not_sent',
      cause: error,
      details: { target, cause_code: error?.code ?? null },
    });
  }
  return new Adapter(options);
}
