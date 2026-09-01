const MAX_RESPONSE_BYTES = 1024 * 1024;

export function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, ...details });
}

export class TraeGatewayClient {
  constructor({
    port = Number(process.env.UAGENTS_TRAE_GATEWAY_PORT ?? process.env.TRAECN_GATEWAY_PORT ?? 8788),
    token = process.env.TRAECN_GATEWAY_TOKEN ?? '',
    fetchImpl = fetch,
  } = {}) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('invalid_gateway_port', 'TRAE gateway port must be 1024–65535.');
    this.origin = `http://127.0.0.1:${port}`;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(method, pathname, { body, idempotencyKey, timeoutMs = 8000 } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response;
    try {
      response = await this.fetchImpl(`${this.origin}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      fail('gateway_unavailable', 'TRAE gateway is unavailable on the configured loopback port.', { transportUnknown: true });
    }
    const declared = Number(response.headers?.get?.('content-length') ?? 0);
    if (declared > MAX_RESPONSE_BYTES) fail('gateway_response_too_large', 'TRAE gateway response exceeds 1 MiB.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) fail('gateway_response_too_large', 'TRAE gateway response exceeds 1 MiB.');
    const text = new TextDecoder().decode(bytes);
    let value;
    try { value = text ? JSON.parse(text) : {}; }
    catch { fail('gateway_invalid_json', 'TRAE gateway returned invalid JSON.'); }
    if (!response.ok) {
      const code = typeof value?.code === 'string' ? value.code : `gateway_http_${response.status}`;
      const message = String(value?.message ?? value?.error ?? `TRAE gateway HTTP ${response.status}`).slice(0, 500);
      fail(code, message, { httpStatus: response.status, gatewayRejected: true });
    }
    return value;
  }

  status() { return this.request('GET', '/api/status'); }
  submit(body, requestId) { return this.request('POST', '/api/tasks/submit', { body, idempotencyKey: requestId, timeoutMs: 20000 }); }
  task(taskId) { return this.request('GET', `/api/task/${encodeURIComponent(taskId)}`); }
}
