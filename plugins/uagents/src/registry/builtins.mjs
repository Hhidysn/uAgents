const target = (modes, inputs, outputs, permissions, extra = {}) => ({
  enabled: true,
  modes,
  inputs,
  outputs,
  permissions,
  ...extra,
});

export const BUILTIN_REGISTRY = Object.freeze({
  version: 'builtin-2026-09-04',
  targets: Object.freeze({
    agy: target(['analysis', 'implementation'], { text: true, files: false, images: false, workspace_readable: true }, { text: true, files: true, images: false }, {
      native: true, advisory_read_only: true, enforced_read_only: false, workspace_write: false, full_access: false,
    }, { transport: 'cli', model_selection: 'explicit', cancel: 'local-request', resume: false, fork: false,
      lifecycle: { managed: true, auto_launch: false, profile: 'inherit-env', ensure: true, resume: false, stop: false } }),
    codex: target(['analysis', 'implementation'], { text: true, files: false, images: false, workspace_readable: true }, { text: true, files: true, images: false }, {
      native: true, advisory_read_only: true, enforced_read_only: false, workspace_write: false, full_access: false,
    }, { transport: 'cli-jsonl', model_selection: 'explicit', cancel: 'local-request', resume: false, fork: false,
      lifecycle: { managed: true, auto_launch: false, profile: 'inherit-env', ensure: true, resume: false, stop: false } }),
    workbuddy: target(['analysis', 'implementation'], { text: true, files: false, images: true, workspace_readable: true }, { text: true, files: true, images: false }, {
      native: true, advisory_read_only: true, enforced_read_only: false, workspace_write: false, full_access: false,
    }, { transport: 'cli', model_selection: 'mixed', cancel: 'local-request', resume: true, fork: true,
      lifecycle: { managed: true, auto_launch: false, profile: 'inherit-env', ensure: true, resume: false, stop: false } }),
    dsh: target(['analysis', 'implementation'], { text: true, files: false, images: false, workspace_readable: true }, { text: true, files: true, images: false }, {
      native: true, advisory_read_only: true, enforced_read_only: false, workspace_write: false, full_access: false,
    }, { transport: 'sdk-jsonrpc-stdio', model_selection: 'explicit', cancel: 'local-request', resume: false, fork: false,
      lifecycle: { managed: true, auto_launch: false, profile: 'inherit-env', ensure: true, resume: false, stop: false } }),
    opencode: target(['analysis', 'implementation'], { text: true, files: true, images: true, workspace_readable: true }, { text: true, files: true, images: false }, {
      native: true, advisory_read_only: true, enforced_read_only: false, workspace_write: false, full_access: false,
    }, { transport: 'cli', model_selection: 'explicit', cancel: 'local-request', resume: true, fork: true,
      execution_timeout: process.platform === 'win32',
      lifecycle: { managed: true, auto_launch: false, profile: 'inherit-env', ensure: true, resume: false, stop: false } }),
    doubao: target(['analysis'], { text: true, files: false, images: false, workspace_readable: false }, { text: true, files: false, images: false }, {
      native: true, advisory_read_only: true, enforced_read_only: false, workspace_write: false, full_access: false,
    }, { transport: 'cdp', model_selection: 'default', cancel: 'unsupported', resume: false, fork: false,
      lifecycle: { managed: true, auto_launch: true, profile: 'isolated', ensure: true, resume: true, stop: true } }),
    trae: target(['analysis', 'implementation'], { text: true, files: false, images: false, workspace_readable: true }, { text: true, files: true, images: false }, {
      native: true, advisory_read_only: true, enforced_read_only: false, workspace_write: false, full_access: false,
    }, { transport: 'gateway', model_selection: 'default', cancel: 'unsupported', resume: false, fork: false,
      lifecycle: { managed: true, auto_launch: true, profile: 'isolated', ensure: true, resume: true, stop: true } }),
  }),
  models: Object.freeze({
    'gemini-3.8-flash-medium': Object.freeze({ target: 'agy', model: 'gemini-3.8-flash-medium', provider: 'agy', route_id: 'agy/gemini-3.8-flash-medium', kind: 'exact', enabled: true, opt_in: false }),
    'gpt-6-astra': Object.freeze({ target: 'codex', model: 'gpt-6-astra', provider: 'codex', route_id: 'codex/gpt-6-astra', kind: 'exact', enabled: true, opt_in: false }),
    'gpt-5.6-luna': Object.freeze({ target: 'codex', model: 'gpt-5.6-luna', provider: 'codex', route_id: 'codex/gpt-5.6-luna', kind: 'exact', enabled: true, opt_in: false }),
    'workbuddy-default': Object.freeze({ target: 'workbuddy', model: null, provider: 'workbuddy', route_id: 'workbuddy-default', kind: 'backend_default', enabled: true, opt_in: false, inputs: { files: false, images: false } }),
    'deepseek-v4.1-flash': Object.freeze({ target: 'workbuddy', model: 'deepseek-v4.1-flash', provider: 'workbuddy', route_id: 'workbuddy/deepseek-v4.1-flash', kind: 'exact', enabled: true, opt_in: false, inputs: { files: false, images: true } }),
    'deepseek-official/deepseek-flash': Object.freeze({ target: 'dsh', model: 'deepseek-flash', provider: 'deepseek-official', route_id: 'deepseek-official/deepseek-flash', kind: 'exact', enabled: true, opt_in: false }),
    'commandcode-goat/deepseek/deepseek-v4-flash': Object.freeze({ target: 'opencode', model: 'deepseek-v4-flash', provider: 'commandcode-goat/deepseek', route_id: 'commandcode-goat/deepseek/deepseek-v4-flash', kind: 'exact', enabled: true, opt_in: false }),
    'commandcode-goat/z-ai/glm-5.3-flash': Object.freeze({ target: 'opencode', model: 'glm-5.3-flash', provider: 'commandcode-goat/z-ai', route_id: 'commandcode-goat/z-ai/glm-5.3-flash', kind: 'exact', enabled: true, opt_in: false }),
    'doubao-default': Object.freeze({ target: 'doubao', model: null, provider: 'doubao', route_id: 'doubao-default', kind: 'backend_default', enabled: true, opt_in: false }),
    'trae-default': Object.freeze({ target: 'trae', model: null, provider: 'trae', route_id: 'trae-default', kind: 'backend_default', enabled: true, opt_in: false }),
  }),
  defaults: Object.freeze({ workbuddy: 'workbuddy-default', doubao: 'doubao-default', trae: 'trae-default' }),
});
