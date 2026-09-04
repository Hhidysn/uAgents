const BASE_KEYS = Object.freeze([
  'PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
  'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA',
  'ProgramFiles', 'ProgramFiles(x86)', 'LANG', 'LC_ALL', 'NO_COLOR', 'TERM',
]);

const UAGENTS_KEYS = Object.freeze([
  'UAGENTS_WORKBUDDY_CLI', 'UAGENTS_OPENCODE_BIN', 'UAGENTS_DOUBAO_CDP_PORT',
  'UAGENTS_TRAE_GATEWAY_PORT', 'TRAECN_GATEWAY_PORT', 'TRAECN_GATEWAY_TOKEN',
]);

export function childEnvironment(source = process.env, extra = {}) {
  const result = {};
  for (const key of [...BASE_KEYS, ...UAGENTS_KEYS]) if (typeof source[key] === 'string') result[key] = source[key];
  for (const [key, value] of Object.entries(extra)) if (typeof value === 'string') result[key] = value;
  return result;
}
