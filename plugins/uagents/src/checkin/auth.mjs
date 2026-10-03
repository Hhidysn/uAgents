import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { runNoPromptCommand } from '../transports/no-prompt-command.mjs';

const TRAE_AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
const DEVICE_PREFIX = 'iCubeAuthInfo://icube-dc:';
// Format constants from auto-checkin/trae_crypto.py; these are not user keys.
const TRAE_MIX = Buffer.from([
  82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,
  84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37,
].map((value, index) => value ^ [
  31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,
  160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125,
][index]));

export function decryptTraeAuth(encoded) {
  if (typeof encoded !== 'string') throw new Error('unsupported_auth_format');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 54 || !bytes.subarray(0, 6).equals(Buffer.from([116, 99, 5, 16, 0, 0])) || (bytes.length - 38) % 16) {
    throw new Error('unsupported_auth_format');
  }
  const sha512 = data => createHash('sha512').update(data).digest();
  const material = sha512(Buffer.concat([sha512(bytes.subarray(6, 38)), TRAE_MIX]));
  try {
    const cipher = createDecipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
    const plain = Buffer.concat([cipher.update(bytes.subarray(38)), cipher.final()]);
    try {
      if (plain.length <= 64 || !timingSafeEqual(plain.subarray(0, 64), sha512(plain.subarray(64)))) throw new Error();
      return JSON.parse(plain.subarray(64).toString('utf8'));
    } finally { plain.fill(0); }
  } finally { material.fill(0); }
}

function readJson(file) {
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('unsupported_auth_format');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function expired(token, expiration, now) {
  if (expiration !== undefined && expiration !== null && expiration !== '') {
    const value = typeof expiration === 'number' ? expiration : Date.parse(expiration);
    if (!Number.isFinite(value) || value <= now) return true;
  }
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= now) return true;
  } catch {}
  return false;
}

export async function loadCheckinAuth(target, { env = process.env, now = Date.now(), commandRunner = runNoPromptCommand } = {}) {
  if (target === 'trae') {
    if (!env.APPDATA || !path.isAbsolute(env.APPDATA)) return { logged_in: false, reason: 'auth_missing' };
    let reason = 'auth_missing';
    for (const source of ['TRAE SOLO CN', 'Trae CN']) {
      const file = path.join(env.APPDATA, source, 'User', 'globalStorage', 'storage.json');
      if (!fs.existsSync(file)) continue;
      try {
        const store = readJson(file);
        if (!store[TRAE_AUTH_KEY]) continue;
        const info = decryptTraeAuth(store[TRAE_AUTH_KEY]);
        if (typeof info.token !== 'string' || !info.token.trim()) { reason = 'auth_missing'; continue; }
        if (expired(info.token, info.expiredAt, now)) { reason = 'auth_expired'; continue; }
        const device = Object.keys(store).find(key => key.startsWith(DEVICE_PREFIX));
        return { logged_in: true, source, token: info.token, domain: 'api.trae.cn', device_id: device?.slice(DEVICE_PREFIX.length) ?? '' };
      } catch { reason = 'auth_unreadable'; }
    }
    return { logged_in: false, reason };
  }
  if (target !== 'workbuddy') throw new Error('invalid_checkin_target');
  if (!env.LOCALAPPDATA || !path.isAbsolute(env.LOCALAPPDATA)) return { logged_in: false, reason: 'auth_missing' };
  const file = path.join(env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
  if (!fs.existsSync(file)) return { logged_in: false, reason: 'auth_missing' };
  try {
    const auth = readJson(file).auth;
    const domain = auth?.domain || 'www.codebuddy.cn';
    // Never forward a local credential to an arbitrary domain from an auth file.
    if (domain !== 'www.codebuddy.cn') return { logged_in: false, reason: 'unsupported_auth_domain' };
    let token = auth?.accessToken;
    if (token?.$wbEncrypted === 1) {
      const executable = env.ProgramFiles && path.join(env.ProgramFiles, 'WorkBuddy', 'WorkBuddy.exe');
      if (!executable || !fs.existsSync(executable)) return { logged_in: false, reason: 'credential_runtime_missing' };
      const helper = fileURLToPath(new URL('./workbuddy-credential-child.cjs', import.meta.url));
      const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
      delete childEnv.NODE_OPTIONS; delete childEnv.NODE_PATH;
      const result = await commandRunner(executable, [helper, file], { env: childEnv, timeout: 5000, maxBuffer: 32768 });
      if (result.status !== 0) return { logged_in: false, reason: 'unsupported_auth_format' };
      token = JSON.parse(result.stdout).value;
    }
    if (typeof token !== 'string' || !token.trim()) return { logged_in: false, reason: 'auth_missing' };
    if (expired(token, auth.expiresAt, now)) return { logged_in: false, reason: 'auth_expired' };
    return { logged_in: true, source: 'WorkBuddy', token, domain };
  } catch { return { logged_in: false, reason: 'auth_unreadable' }; }
}

export function authSummary(target, auth) {
  return { target, logged_in: auth.logged_in, ...(auth.source ? { source: auth.source } : {}), ...(auth.reason ? { reason: auth.reason } : {}) };
}
