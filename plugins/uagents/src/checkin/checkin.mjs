import { setTimeout as delay } from 'node:timers/promises';
import { authSummary, loadCheckinAuth } from './auth.mjs';

export const CHECKIN_TARGETS = Object.freeze(['trae', 'workbuddy']);

export function checkinTargets(targets = CHECKIN_TARGETS) {
  if (!Array.isArray(targets) || targets.some(target => !CHECKIN_TARGETS.includes(target))) throw new Error('invalid_checkin_target');
  return [...new Set(targets)];
}

async function request(auth, pathname, { fetchImpl, timeoutMs }) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'uAgents-checkin/1.0',
    Authorization: auth.domain === 'api.trae.cn' ? `Cloud-IDE-JWT ${auth.token}` : `Bearer ${auth.token}` };
  if (auth.device_id) Object.assign(headers, { 'x-device-id': auth.device_id, 'x-device-brand': 'PC', 'x-device-type': 'Windows' });
  try {
    const response = await fetchImpl(`https://${auth.domain}${pathname}`, {
      method: 'POST', headers, body: '{}', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (Number(response.headers.get('content-length')) > 262144) throw new Error();
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length; if (bytes > 262144) throw new Error(); chunks.push(Buffer.from(chunk));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
    return { http_status: response.status, data };
  } catch { return { http_status: 0, data: {} }; }
}

function snapshot(target, response) {
  const data = response.data;
  if (response.http_status !== 200 || data.code !== 0) return null;
  const status = target === 'trae' ? data : data.data;
  const checked = target === 'trae' ? status?.checked_in : status?.today_checked_in;
  if (typeof checked !== 'boolean' || (target === 'trae' && typeof status.enable !== 'boolean')) return null;
  return { checked, enabled: target === 'trae' ? status.enable : true,
    ...(Number.isFinite(target === 'trae' ? status.credits : status.today_credit) ? { credits: target === 'trae' ? status.credits : status.today_credit } : {}),
    ...(Number.isFinite(status.streak_days) ? { streak_days: status.streak_days } : {}),
  };
}

async function checkinOne(target, auth, { checkOnly, fetchImpl, timeoutMs, sleep }) {
  const base = authSummary(target, auth);
  if (!auth.logged_in) return { ...base, status: 'skipped' };
  const statusPath = target === 'trae' ? '/trae/api/v2/ug/checkin_credits/status' : '/billing/meter/checkin-status';
  const claimPath = target === 'trae' ? '/trae/api/v2/ug/checkin_credits/claim' : '/billing/meter/daily-checkin';
  const query = () => request(auth, statusPath, { fetchImpl, timeoutMs });
  const response = await query(), before = snapshot(target, response);
  if (!before) return { ...base, status: 'failed', reason: [401, 403].includes(response.http_status) || [1001, 401].includes(response.data.code) ? 'authentication_required' : 'status_query_failed', http_status: response.http_status };
  if (before.checked) return { ...base, status: 'already_checked_in', ...before };
  if (!before.enabled) return { ...base, status: 'skipped', reason: 'activity_disabled' };
  if (checkOnly) return { ...base, status: 'not_checked_in', ...before };
  let claim;
  for (let attempt = 0; attempt < 3; attempt++) {
    claim = await request(auth, claimPath, { fetchImpl, timeoutMs });
    if (target !== 'trae' || claim.http_status !== 200 || claim.data.code !== 9074 || attempt === 2) break;
    await sleep(3000);
  }
  // A lost claim response is reconciled by observation; never replay it here.
  const after = snapshot(target, await query());
  if (after?.checked) return { ...base, status: before.checked || (target === 'workbuddy' && claim.data.code === 10001) ? 'already_checked_in' : 'checked_in', ...after };
  if (target === 'workbuddy' && [200, 400].includes(claim.http_status) && claim.data.code === 10001 &&
      /今天已签到/.test(String(claim.data.msg ?? ''))) {
    return { ...base, status: 'already_checked_in', checked: true, verification: 'provider_already_checked_in',
      status_query_checked: after?.checked ?? null, provider_code: 10001 };
  }
  const rejected = claim.http_status >= 400 || (claim.http_status === 200 && Number.isInteger(claim.data.code) && claim.data.code !== 0);
  return { ...base, status: rejected ? 'failed' : 'unconfirmed', reason: rejected ? 'claim_rejected' : 'claim_result_unconfirmed', http_status: claim.http_status,
    ...(Number.isInteger(claim.data.code) ? { provider_code: claim.data.code } : {}) };
}

export async function runCheckins({ targets = CHECKIN_TARGETS, checkOnly = false, env = process.env,
  authLoader = loadCheckinAuth, fetchImpl = fetch, timeoutMs = 15000, sleep = delay } = {}) {
  const results = [];
  for (const target of checkinTargets(targets)) {
    try {
      const auth = await authLoader(target, { env });
      results.push(await checkinOne(target, auth, { checkOnly, fetchImpl, timeoutMs, sleep }));
    } catch { results.push({ target, logged_in: false, status: 'failed', reason: 'checkin_unavailable' }); }
  }
  return { schema_version: '1.0', checked_at: new Date().toISOString(), check_only: checkOnly, results };
}
