(function attachTraecnConsoleApp(root, factory) {
  'use strict';

  const stateApi =
    root?.TraecnConsoleState ||
    (typeof module === 'object' && module.exports ? require('./state') : null);
  const api = factory(stateApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TraecnConsoleApp = api;
  if (root?.document && stateApi) {
    api.bootstrap({ root }).catch(() => {
      const shell = root.document.querySelector('.console-shell');
      if (shell) shell.dataset.appState = 'failed';
    });
  }
})(typeof globalThis === 'object' ? globalThis : this, function createTraecnConsoleApp(State) {
  'use strict';

  const SESSION_TOKEN_KEY = 'traecnclaw.console.token';
  const LEGACY_TOKEN_KEY = 'traecn_bridge_token';
  const WS_PUBLIC_PROTOCOL = 'traecnclaw.v1';
  const WS_BEARER_PROTOCOL_PREFIX = 'traecnclaw.bearer.';
  const RECONNECT_DELAYS_MS = Object.freeze([1000, 2000, 5000, 10000, 15000]);
  const TERMINAL_LABELS = Object.freeze({
    done: '已完成',
    error: '失败',
    cancelled: '已取消',
    queue_timeout: '排队超时',
    review_rejected: '审查拒绝',
  });
  const STATUS_LABELS = Object.freeze({
    queued: '排队中',
    executing: '执行中',
    approval_required: '需要确认',
    awaiting_review: '等待审查',
    ...TERMINAL_LABELS,
    unknown: '状态未知',
  });

  class ApiError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = options.status || 0;
      this.code = options.code || null;
      this.retryAfter = options.retryAfter || null;
      this.payload = options.payload || null;
    }
  }

  function safeText(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const normalized = Array.from(value, (character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
      .join('')
      .trim();
    return normalized || fallback;
  }

  function safeErrorMessage(error) {
    if (!(error instanceof ApiError)) return '请求暂时失败，请稍后重试。';
    if (error.status === 401 || error.status === 403) return '令牌无效或网关拒绝了当前会话。';
    if (error.status === 409) return '界面状态已变化，已请求刷新后再操作。';
    if (error.status === 429) {
      return error.retryAfter
        ? `请求过于频繁，请在 ${error.retryAfter} 后重试。`
        : '请求过于频繁，请稍后重试。';
    }
    if (error.status === 503) return 'TraeCN 或本机网关暂时不可用。';
    return safeText(error.message, '请求暂时失败，请稍后重试。').slice(0, 300);
  }

  function createTokenStore(sessionStore, legacyStore) {
    return {
      load() {
        try {
          return safeText(sessionStore?.getItem?.(SESSION_TOKEN_KEY), '');
        } catch {
          return '';
        }
      },
      save(token) {
        try {
          if (token) sessionStore?.setItem?.(SESSION_TOKEN_KEY, token);
          else sessionStore?.removeItem?.(SESSION_TOKEN_KEY);
        } catch {
          // A blocked sessionStorage still permits an in-memory connection.
        }
      },
      clear() {
        try {
          sessionStore?.removeItem?.(SESSION_TOKEN_KEY);
        } catch {
          // Storage cleanup is best effort.
        }
      },
      removeLegacy() {
        try {
          legacyStore?.removeItem?.(LEGACY_TOKEN_KEY);
        } catch {
          // A legacy store may be unavailable under hardened browser settings.
        }
      },
    };
  }

  function encodeUtf8Base64Url(value, platform = {}) {
    const input = String(value || '');
    if (platform.Buffer) return platform.Buffer.from(input, 'utf8').toString('base64url');
    const encoder = platform.TextEncoder ? new platform.TextEncoder() : null;
    if (!encoder || typeof platform.btoa !== 'function') {
      throw new Error('UTF-8 base64url encoding is unavailable');
    }
    const bytes = encoder.encode(input);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return platform.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function websocketProtocols(token, platform = {}) {
    const protocols = [WS_PUBLIC_PROTOCOL];
    if (token)
      protocols.push(`${WS_BEARER_PROTOCOL_PREFIX}${encodeUtf8Base64Url(token, platform)}`);
    return protocols;
  }

  function buildWebSocketUrl(locationLike) {
    const origin = safeText(locationLike?.origin);
    if (!origin) throw new Error('A same-origin location is required');
    const url = new URL('/ws/events', origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  function reconnectDelay(attempt) {
    const index = Math.max(0, Math.min(Number(attempt) || 0, RECONNECT_DELAYS_MS.length - 1));
    return RECONNECT_DELAYS_MS[index];
  }

  function createIdempotencyKey(platform = {}) {
    if (typeof platform.randomUUID === 'function') return `console-${platform.randomUUID()}`;
    const now = typeof platform.now === 'function' ? platform.now() : Date.now();
    const random = typeof platform.random === 'function' ? platform.random() : Math.random();
    return `console-${now.toString(36)}-${random.toString(36).slice(2)}`;
  }

  function createApiClient(options = {}) {
    const fetchImpl = options.fetch;
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
    const origin = safeText(options.origin);
    if (!origin) throw new TypeError('origin is required');
    let token = safeText(options.token, '');

    async function request(path, requestOptions = {}) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
        throw new TypeError('Only same-origin absolute paths are allowed');
      }
      const url = new URL(path, origin);
      if (url.origin !== new URL(origin).origin)
        throw new TypeError('Cross-origin requests are forbidden');
      const headers = {
        Accept: 'application/json',
        ...(requestOptions.headers || {}),
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      let body;
      if (requestOptions.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(requestOptions.body);
      }
      const response = await fetchImpl(url.toString(), {
        method: requestOptions.method || 'GET',
        headers,
        body,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        signal: requestOptions.signal,
      });
      const contentType = safeText(response.headers?.get?.('content-type'), '');
      let payload = null;
      if (response.status !== 204) {
        try {
          payload = contentType.includes('application/json')
            ? await response.json()
            : { message: (await response.text()).slice(0, 500) };
        } catch {
          payload = null;
        }
      }
      if (!response.ok) {
        const publicMessage = safeText(
          payload?.message || payload?.error,
          `HTTP ${response.status}`
        );
        throw new ApiError(publicMessage, {
          status: response.status,
          code: safeText(payload?.code || payload?.error, ''),
          retryAfter: safeText(response.headers?.get?.('retry-after'), ''),
          payload,
        });
      }
      return payload;
    }

    return {
      request,
      setToken(nextToken) {
        token = safeText(nextToken, '');
      },
      hasToken() {
        return Boolean(token);
      },
    };
  }

  function listFromModels(payload) {
    const models = Array.isArray(payload?.models) ? payload.models : [];
    return models
      .map((item) => safeText(typeof item === 'string' ? item : item?.name || item?.id, ''))
      .filter(Boolean);
  }

  function terminalHistoryTasks(items) {
    return (Array.isArray(items) ? items : []).filter(
      (item) => item?.taskId && State.isTerminalStatus(State.normalizeStatus(item.status))
    );
  }

  function compactTaskMessage(task) {
    const text = safeText(task?.message || task?.result?.text || task?.error, '未提供任务摘要');
    return text.length > 260 ? `${text.slice(0, 257)}…` : text;
  }

  function formattedTime(value) {
    const timestamp = typeof value === 'number' ? value : Date.parse(value || '');
    if (!Number.isFinite(timestamp)) return '时间未知';
    try {
      return new Date(timestamp).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return new Date(timestamp).toISOString();
    }
  }

  function basename(path) {
    const normalized = safeText(path, '').replace(/\/+$/, '');
    return normalized.split('/').pop() || '未选择';
  }

  class ConsoleController {
    constructor(options) {
      this.root = options.root;
      this.document = options.root.document;
      this.location = options.root.location;
      this.storage = createTokenStore(options.root.sessionStorage, options.root.localStorage);
      this.storage.removeLegacy();
      this.api = createApiClient({
        fetch: options.root.fetch.bind(options.root),
        origin: this.location.origin,
      });
      this.state = State.createInitialState();
      this.catalog = {
        workspace: null,
        models: [],
        conversations: [],
        readiness: null,
        config: null,
        configDiff: null,
        metrics: null,
        openapi: null,
      };
      this.token = '';
      this.socket = null;
      this.socketReconnectTimer = null;
      this.pollTimer = null;
      this.reconnectAttempt = 0;
      this.disconnectedByUser = false;
      this.startedAt = Date.now();
      this.historyPage = 1;
      this.taskDrafts = new Map();
      this.subscribedTaskIds = new Set();
      this.lastStatuses = new Map();
      this.lastFocus = null;
      this.drawerOpen = false;
      this.refs = {};
    }

    byId(id) {
      return this.document.getElementById(id);
    }

    element(tag, className, text) {
      const node = this.document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    }

    dispatch(action) {
      this.state = State.reduceState(this.state, action);
      this.render();
    }

    rememberRefs() {
      const ids = [
        'runtime-status',
        'runtime-status-label',
        'header-workspace',
        'refresh-console',
        'open-advanced',
        'open-connection',
        'connection-banner',
        'connection-banner-copy',
        'context-freshness',
        'workspace-name',
        'workspace-path',
        'open-workspace',
        'model-select',
        'mode-select',
        'conversation-select',
        'composer-context-lock',
        'task-form',
        'task-message',
        'review-required',
        'submit-hint',
        'submit-task',
        'notice-stack',
        'attention-section',
        'attention-count',
        'attention-list',
        'active-count',
        'active-task-list',
        'result-task-list',
        'refresh-history',
        'history-health',
        'history-list',
        'load-more-history',
        'connection-dialog',
        'connection-form',
        'gateway-token',
        'connection-error',
        'disconnect-gateway',
        'workspace-dialog',
        'workspace-form',
        'workspace-input',
        'workspace-error',
        'task-detail-dialog',
        'task-detail-state',
        'task-detail-title',
        'task-detail-body',
        'task-detail-actions',
        'advanced-drawer',
        'runtime-diagnostics',
        'durability-diagnostics',
        'metrics-diagnostics',
        'openapi-link',
        'toast-region',
        'live-region',
      ];
      for (const id of ids) this.refs[id] = this.byId(id);
    }

    bind() {
      this.rememberRefs();
      this.refs['open-connection'].addEventListener('click', (event) =>
        this.openDialog(this.refs['connection-dialog'], event.currentTarget)
      );
      for (const button of this.document.querySelectorAll('[data-open-connection]')) {
        button.addEventListener('click', (event) =>
          this.openDialog(this.refs['connection-dialog'], event.currentTarget)
        );
      }
      for (const button of this.document.querySelectorAll('[data-close-dialog]')) {
        button.addEventListener('click', () => button.closest('dialog')?.close());
      }
      for (const dialog of this.document.querySelectorAll('dialog')) {
        dialog.addEventListener('close', () => {
          if (this.lastFocus?.isConnected) this.lastFocus.focus();
          this.lastFocus = null;
        });
      }
      this.refs['connection-form'].addEventListener('submit', (event) =>
        this.handleConnectionSubmit(event)
      );
      this.refs['disconnect-gateway'].addEventListener('click', () => this.disconnect());
      this.refs['refresh-console'].addEventListener('click', () =>
        this.hydrate({ announce: true })
      );
      this.refs['refresh-history'].addEventListener('click', () => this.loadHistory(1, false));
      this.refs['load-more-history'].addEventListener('click', () =>
        this.loadHistory(this.historyPage + 1, true)
      );
      this.refs['open-workspace'].addEventListener('click', (event) => {
        this.refs['workspace-input'].value = this.catalog.workspace?.rootPath || '';
        this.openDialog(this.refs['workspace-dialog'], event.currentTarget);
      });
      this.refs['workspace-form'].addEventListener('submit', (event) =>
        this.handleWorkspaceSubmit(event)
      );
      this.refs['model-select'].addEventListener('change', () => this.changeModel());
      this.refs['mode-select'].addEventListener('change', () => this.changeMode());
      this.refs['conversation-select'].addEventListener('change', () => this.changeConversation());
      this.refs['task-form'].addEventListener('submit', (event) => this.submitTask(event));
      this.refs['task-message'].addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter')
          this.refs['task-form'].requestSubmit();
      });
      this.refs['open-advanced'].addEventListener('click', (event) =>
        this.openAdvanced(event.currentTarget)
      );
      for (const button of this.document.querySelectorAll('[data-close-advanced]')) {
        button.addEventListener('click', () => this.closeAdvanced());
      }
      this.document.addEventListener('keydown', (event) => this.handleGlobalKeydown(event));
      this.document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
      this.refs['openapi-link'].addEventListener('click', (event) =>
        this.downloadProtectedJson(event, '/openapi.json', 'traecnclaw-openapi.json')
      );
    }

    async init() {
      this.bind();
      this.document.querySelector('.console-shell').dataset.appState = 'ready';
      this.render();
      const storedToken = this.storage.load();
      await this.connect(storedToken, { quiet: true });
    }

    openDialog(dialog, trigger) {
      this.lastFocus = trigger || this.document.activeElement;
      if (!dialog.open) dialog.showModal();
      const target = dialog.querySelector('input:not([disabled]), button:not([disabled])');
      if (target) this.root.setTimeout(() => target.focus(), 0);
    }

    setInlineError(id, message) {
      const node = this.refs[id];
      node.textContent = message || '';
      node.hidden = !message;
    }

    async handleConnectionSubmit(event) {
      event.preventDefault();
      const token = this.refs['gateway-token'].value.trim();
      this.refs['gateway-token'].value = '';
      this.setInlineError('connection-error', '');
      await this.connect(token);
    }

    async connect(token, options = {}) {
      this.disconnectedByUser = false;
      this.token = safeText(token, '');
      this.api.setToken(this.token);
      this.dispatch({ type: 'CONNECTION', connection: { auth: 'checking', stale: true } });
      try {
        await this.api.request('/api/queue/status');
        this.storage.save(this.token);
        this.dispatch({
          type: 'CONNECTION',
          connection: { auth: 'ready', lastSuccessAt: Date.now() },
        });
        if (this.refs['connection-dialog'].open) this.refs['connection-dialog'].close();
        await this.hydrate({ announce: !options.quiet });
        this.openSocket();
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          this.storage.clear();
          this.token = '';
          this.api.setToken('');
          this.dispatch({ type: 'LOCK_PROTECTED' });
          this.setInlineError('connection-error', safeErrorMessage(error));
          if (!this.refs['connection-dialog'].open)
            this.openDialog(this.refs['connection-dialog'], this.refs['open-connection']);
        } else {
          this.dispatch({ type: 'CONNECTION', connection: { auth: 'unavailable', stale: true } });
          this.notice('connection-failed', 'danger', '无法连接网关', safeErrorMessage(error));
        }
      }
    }

    disconnect() {
      this.disconnectedByUser = true;
      this.storage.clear();
      this.token = '';
      this.api.setToken('');
      this.stopRealtime();
      this.state = State.createInitialState();
      this.state.connection.auth = 'locked';
      this.catalog.workspace = null;
      this.catalog.models = [];
      this.catalog.conversations = [];
      this.refs['gateway-token'].value = '';
      if (this.refs['connection-dialog'].open) this.refs['connection-dialog'].close();
      this.render();
      this.announce('已断开网关并清除当前标签页令牌。');
    }

    stopRealtime() {
      if (this.socketReconnectTimer) this.root.clearTimeout(this.socketReconnectTimer);
      if (this.pollTimer) this.root.clearTimeout(this.pollTimer);
      this.socketReconnectTimer = null;
      this.pollTimer = null;
      if (this.socket) {
        const socket = this.socket;
        this.socket = null;
        try {
          socket.close(1000, 'client closing');
        } catch {
          /* already closed */
        }
      }
    }

    async hydrate(options = {}) {
      try {
        const runtime = await this.api.request('/api/status');
        this.dispatch({ type: 'RUNTIME', runtime });
      } catch (error) {
        this.notice('runtime-status-failed', 'warning', '状态不可用', safeErrorMessage(error));
      }
      if (this.state.connection.auth !== 'ready') return;

      const requests = [
        ['workspace', '/api/workspace'],
        ['models', '/api/models'],
        ['mode', '/api/detect-mode'],
        ['conversations', '/api/conversations'],
        ['queue', '/api/queue/status'],
        ['history', '/api/tasks/history?page=1&limit=20'],
        ['readiness', '/api/readiness'],
        ['config', '/api/config'],
        ['configDiff', '/api/config/diff'],
        ['metrics', '/metrics.json'],
        ['openapi', '/openapi.json'],
      ];
      const results = await Promise.allSettled(requests.map(([, path]) => this.api.request(path)));
      for (let index = 0; index < requests.length; index += 1) {
        const [kind] = requests[index];
        const result = results[index];
        if (result.status === 'fulfilled') this.applyHydration(kind, result.value);
        else this.handleHydrationError(kind, result.reason);
      }
      this.dispatch({
        type: 'CONNECTION',
        connection: { auth: 'ready', lastSuccessAt: Date.now() },
      });
      if (options.announce) this.announce('控制台上下文与任务状态已刷新。');
      this.subscribeKnownTasks();
    }

    applyHydration(kind, payload) {
      if (kind === 'workspace') {
        this.catalog.workspace = payload;
        this.dispatch({
          type: 'CONTEXT',
          context: { workspace: payload?.rootPath || payload?.selectedPath || null },
        });
        return;
      }
      if (kind === 'models') {
        this.catalog.models = listFromModels(payload);
        this.dispatch({
          type: 'CONTEXT',
          context: { model: safeText(payload?.current || payload?.currentModel, '') || null },
        });
        return;
      }
      if (kind === 'mode') {
        this.dispatch({ type: 'CONTEXT', context: { mode: payload?.mode || null } });
        return;
      }
      if (kind === 'conversations') {
        this.catalog.conversations = Array.isArray(payload?.conversations)
          ? payload.conversations
          : [];
        const active = this.catalog.conversations.find((item) => item.active === true);
        this.dispatch({ type: 'CONTEXT', context: { conversation: active?.id || null } });
        return;
      }
      if (kind === 'queue') {
        const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
        this.dispatch({ type: 'HYDRATE_TASKS', tasks, authoritativeActive: true });
        Promise.allSettled(tasks.map((task) => this.fetchTask(task.taskId))).then(() =>
          this.render()
        );
        return;
      }
      if (kind === 'history') {
        this.historyPage = 1;
        this.dispatch({ type: 'HISTORY', page: payload, append: false });
        this.mergeHistoryTasks(payload?.tasks || []);
        return;
      }
      this.catalog[kind] = payload;
      this.render();
    }

    handleHydrationError(kind, error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        this.storage.clear();
        this.token = '';
        this.api.setToken('');
        this.dispatch({ type: 'LOCK_PROTECTED' });
        return;
      }
      if (kind === 'workspace') this.catalog.workspace = { verified: false };
      this.dispatch({
        type: 'DIAGNOSTIC',
        code: `hydrate_${kind}_failed`,
        detail: { status: error?.status || 0, code: error?.code || null },
      });
    }

    mergeHistoryTasks(items) {
      const historyItems = Array.isArray(items) ? items : [];
      for (const item of terminalHistoryTasks(historyItems)) {
        if (this.state.tasks[item.taskId]) continue;
        this.state = State.reduceState(this.state, { type: 'UPSERT_TASK', task: item });
      }
      for (const item of historyItems) {
        if (!item?.taskId || !this.state.tasks[item.taskId]) continue;
        const current = this.state.tasks[item.taskId];
        this.state = State.reduceState(this.state, {
          type: 'UPSERT_TASK',
          task: {
            ...item,
            task: item.task || current.message,
            context: current.context,
            revision: current._revision,
          },
        });
      }
      this.render();
    }

    async loadHistory(page, append) {
      if (this.state.connection.auth !== 'ready') return;
      try {
        const payload = await this.api.request(`/api/tasks/history?page=${page}&limit=20`);
        this.historyPage = page;
        this.dispatch({ type: 'HISTORY', page: payload, append });
        this.mergeHistoryTasks(payload?.tasks || []);
      } catch (error) {
        this.notice('history-failed', 'warning', '历史加载失败', safeErrorMessage(error));
      }
    }

    openSocket() {
      if (this.disconnectedByUser || this.state.connection.auth !== 'ready' || this.document.hidden)
        return;
      if (!this.root.WebSocket) {
        this.startFallbackPolling();
        return;
      }
      if (this.socket && this.socket.readyState < 2) return;
      try {
        const protocols = websocketProtocols(this.token, {
          TextEncoder: this.root.TextEncoder,
          btoa: this.root.btoa?.bind(this.root),
        });
        const socket = new this.root.WebSocket(buildWebSocketUrl(this.location), protocols);
        this.socket = socket;
        socket.addEventListener('open', () => {
          if (this.socket !== socket) return;
          this.reconnectAttempt = 0;
          this.dispatch({ type: 'SOCKET_OPEN', at: Date.now() });
          this.subscribeKnownTasks();
          if (this.pollTimer) this.root.clearTimeout(this.pollTimer);
          this.pollTimer = null;
        });
        socket.addEventListener('message', (event) => this.handleSocketMessage(event.data));
        socket.addEventListener('close', () => {
          if (this.socket === socket) this.socket = null;
          if (this.disconnectedByUser) return;
          this.dispatch({ type: 'SOCKET_CLOSED', attempt: this.reconnectAttempt });
          this.scheduleReconnect();
          this.startFallbackPolling();
        });
        socket.addEventListener('error', () => {
          this.dispatch({
            type: 'DIAGNOSTIC',
            code: 'socket_error',
            detail: { attempt: this.reconnectAttempt },
          });
        });
      } catch (error) {
        this.dispatch({
          type: 'DIAGNOSTIC',
          code: 'socket_open_failed',
          detail: { message: safeErrorMessage(error) },
        });
        this.scheduleReconnect();
        this.startFallbackPolling();
      }
    }

    scheduleReconnect() {
      if (this.disconnectedByUser || this.document.hidden || this.socketReconnectTimer) return;
      const delay = reconnectDelay(this.reconnectAttempt);
      this.reconnectAttempt += 1;
      this.socketReconnectTimer = this.root.setTimeout(() => {
        this.socketReconnectTimer = null;
        this.openSocket();
      }, delay);
    }

    startFallbackPolling() {
      if (
        this.disconnectedByUser ||
        this.document.hidden ||
        this.pollTimer ||
        this.state.connection.auth !== 'ready'
      )
        return;
      const tick = async () => {
        this.pollTimer = null;
        if (
          this.disconnectedByUser ||
          this.document.hidden ||
          this.state.connection.socket === 'open'
        )
          return;
        try {
          const queue = await this.api.request('/api/queue/status');
          const tasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
          this.dispatch({ type: 'HYDRATE_TASKS', tasks, authoritativeActive: true });
          await Promise.allSettled(tasks.map((task) => this.fetchTask(task.taskId)));
        } catch (error) {
          this.handleHydrationError('queue', error);
        }
        const interval = Date.now() - this.startedAt < 300000 ? 5000 : 15000;
        this.pollTimer = this.root.setTimeout(tick, interval);
      };
      this.pollTimer = this.root.setTimeout(tick, 5000);
    }

    subscribeKnownTasks() {
      if (!this.socket || this.socket.readyState !== 1) return;
      for (const task of Object.values(this.state.tasks)) {
        if (State.isActiveStatus(task.status)) this.subscribeTask(task.taskId);
      }
    }

    subscribeTask(taskId) {
      if (!taskId || !this.socket || this.socket.readyState !== 1) return;
      this.socket.send(JSON.stringify({ type: 'subscribe', taskId }));
      this.subscribedTaskIds.add(taskId);
    }

    async handleSocketMessage(raw) {
      let event;
      try {
        event = JSON.parse(String(raw));
      } catch {
        this.dispatch({
          type: 'DIAGNOSTIC',
          code: 'invalid_socket_json',
          detail: { size: String(raw).length },
        });
        return;
      }
      const classified = State.classifySocketEvent(event);
      const previousStatus = classified.taskId ? this.state.tasks[classified.taskId]?.status : null;
      this.state = State.reduceSocketEvent(this.state, event);
      if (classified.kind === 'refresh' && classified.taskId)
        await this.fetchTask(classified.taskId);
      else this.render();
      const nextStatus = classified.taskId ? this.state.tasks[classified.taskId]?.status : null;
      if (nextStatus && nextStatus !== previousStatus)
        this.announceStatus(classified.taskId, nextStatus);
    }

    async fetchTask(taskId) {
      if (!taskId) return null;
      try {
        const payload = await this.api.request(`/api/task/${encodeURIComponent(taskId)}`);
        const prior = this.state.tasks[taskId];
        const draft = this.taskDrafts.get(taskId);
        const history = this.state.history.items.find((item) => item.taskId === taskId);
        const task = {
          ...payload,
          task:
            draft?.message ||
            history?.message ||
            prior?.message ||
            payload?.task ||
            payload?.message,
          context: draft?.context || prior?.context || history?.context,
        };
        const oldStatus = prior?.status;
        this.dispatch({ type: 'UPSERT_TASK', task });
        const newStatus = this.state.tasks[taskId]?.status;
        if (newStatus && newStatus !== oldStatus) this.announceStatus(taskId, newStatus);
        if (State.isTerminalStatus(newStatus)) {
          this.taskDrafts.delete(taskId);
          this.loadHistory(1, false);
        }
        return task;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404))
          this.handleHydrationError('task', error);
        return null;
      }
    }

    announceStatus(taskId, status) {
      if (this.lastStatuses.get(taskId) === status) return;
      this.lastStatuses.set(taskId, status);
      this.announce(`任务 ${taskId}：${STATUS_LABELS[status] || status}。`);
    }

    announce(message) {
      this.refs['live-region'].textContent = '';
      this.root.setTimeout(() => {
        this.refs['live-region'].textContent = message;
      }, 20);
    }

    notice(id, tone, title, message) {
      this.dispatch({ type: 'NOTICE', notice: { id, tone, title, message } });
    }

    async handleWorkspaceSubmit(event) {
      event.preventDefault();
      const projectPath = this.refs['workspace-input'].value.trim();
      this.setInlineError('workspace-error', '');
      try {
        await this.api.request('/api/open-project', { method: 'POST', body: { projectPath } });
        const workspace = await this.api.request('/api/workspace');
        this.applyHydration('workspace', workspace);
        if (!workspace?.verified)
          throw new ApiError('工作区切换后未通过精确路径验证', { status: 409 });
        this.refs['workspace-dialog'].close();
        this.announce(`工作区已验证：${workspace.rootPath}`);
      } catch (error) {
        this.setInlineError('workspace-error', safeErrorMessage(error));
      }
    }

    async changeModel() {
      const model = this.refs['model-select'].value;
      if (!model || model === this.state.context.model) return;
      this.setContextBusy(true);
      try {
        const result = await this.api.request('/api/switch-model', {
          method: 'POST',
          body: { model, waitForQueue: false },
        });
        this.dispatch({ type: 'CONTEXT', context: { model: result?.model || model } });
        this.announce(`模型已切换为 ${result?.model || model}。`);
      } catch (error) {
        this.notice('model-switch-failed', 'danger', '模型切换失败', safeErrorMessage(error));
      } finally {
        this.setContextBusy(false);
      }
    }

    async changeMode() {
      const mode = this.refs['mode-select'].value;
      if (!mode || mode === this.state.context.mode) return;
      this.setContextBusy(true);
      try {
        const result = await this.api.request('/api/switch-mode', {
          method: 'POST',
          body: { mode },
        });
        this.dispatch({
          type: 'CONTEXT',
          context: { mode: result?.mode || mode, conversation: null },
        });
        const conversations = await this.api.request('/api/conversations');
        this.applyHydration('conversations', conversations);
        this.announce(`模式已切换为 ${mode.toUpperCase()}。`);
      } catch (error) {
        this.notice('mode-switch-failed', 'danger', '模式切换失败', safeErrorMessage(error));
      } finally {
        this.setContextBusy(false);
      }
    }

    async changeConversation() {
      const conversationId = this.refs['conversation-select'].value;
      if (conversationId === '__new__') {
        try {
          await this.api.request('/api/conversations/manage', {
            method: 'POST',
            body: { action: 'create' },
          });
          const conversations = await this.api.request('/api/conversations');
          this.applyHydration('conversations', conversations);
          this.announce('已创建新的 TraeCN 对话。');
        } catch (error) {
          this.notice(
            'conversation-create-failed',
            'danger',
            '新对话创建失败',
            safeErrorMessage(error)
          );
        }
        return;
      }
      if (!conversationId || conversationId === this.state.context.conversation) return;
      try {
        await this.api.request('/api/conversations/manage', {
          method: 'POST',
          body: { action: 'select', conversationId },
        });
        this.dispatch({ type: 'CONTEXT', context: { conversation: conversationId } });
        this.announce('TraeCN 对话已切换。');
      } catch (error) {
        this.notice(
          'conversation-switch-failed',
          'danger',
          '对话切换失败',
          safeErrorMessage(error)
        );
      }
    }

    setContextBusy(busy) {
      for (const id of ['model-select', 'mode-select', 'conversation-select', 'open-workspace']) {
        this.refs[id].disabled = busy || this.state.connection.auth !== 'ready';
      }
    }

    async submitTask(event) {
      event.preventDefault();
      const message = this.refs['task-message'].value.trim();
      if (!message || !this.catalog.workspace?.verified) return;
      const context = { ...this.state.context };
      const body = {
        message,
        workspace: context.workspace,
        model: context.model,
        mode: context.mode,
        conversationId: context.conversation,
        reviewRequired: this.refs['review-required'].checked,
      };
      this.refs['submit-task'].disabled = true;
      try {
        const response = await this.api.request('/api/tasks/submit', {
          method: 'POST',
          headers: {
            'Idempotency-Key': createIdempotencyKey({
              randomUUID: this.root.crypto?.randomUUID?.bind(this.root.crypto),
            }),
          },
          body,
        });
        this.taskDrafts.set(response.taskId, { message, context });
        this.dispatch({
          type: 'UPSERT_TASK',
          task: {
            taskId: response.taskId,
            status: response.status,
            task: message,
            context,
            createdAt: Date.now(),
          },
        });
        this.refs['task-message'].value = '';
        this.subscribeTask(response.taskId);
        await this.fetchTask(response.taskId);
        this.announce(`任务已提交，任务 ID ${response.taskId}。`);
      } catch (error) {
        this.notice('submit-failed', 'danger', '任务提交失败', safeErrorMessage(error));
      } finally {
        this.render();
      }
    }

    async taskAction(task, action, body) {
      try {
        await this.api.request(`/api/task/${encodeURIComponent(task.taskId)}/${action}`, {
          method: 'POST',
          body,
        });
        await this.fetchTask(task.taskId);
      } catch (error) {
        this.notice(
          `task-action-${task.taskId}`,
          'danger',
          '任务操作未完成',
          safeErrorMessage(error)
        );
        if (error instanceof ApiError && error.status === 409) await this.fetchTask(task.taskId);
      }
    }

    async resolveInteraction(task, action, extra = {}) {
      if (!task.interaction?.interactionRequestId) {
        this.notice(
          `interaction-${task.taskId}`,
          'warning',
          '交互已变化',
          '缺少精确交互 ID，已刷新任务。'
        );
        await this.fetchTask(task.taskId);
        return;
      }
      await this.taskAction(task, 'interaction', {
        interactionRequestId: task.interaction.interactionRequestId,
        action,
        ...extra,
      });
    }

    openTaskDetail(task, trigger) {
      this.lastFocus = trigger || this.document.activeElement;
      this.renderTaskDetail(task);
      if (!this.refs['task-detail-dialog'].open) this.refs['task-detail-dialog'].showModal();
      this.refreshTaskDetail(task);
    }

    renderTaskDetail(task) {
      this.refs['task-detail-state'].textContent = STATUS_LABELS[task.status] || task.status;
      this.refs['task-detail-title'].textContent = `任务 ${task.taskId}`;
      const body = this.refs['task-detail-body'];
      body.replaceChildren();
      const grid = this.element('div', 'detail-grid');
      const fields = [
        ['状态', STATUS_LABELS[task.status] || task.status],
        ['任务 ID', task.taskId],
        ['创建时间', formattedTime(task.createdAt || task.createdAtMs)],
        ['Workspace', task.context?.workspace || '未知'],
        ['Model', task.context?.model || '未知'],
        ['Mode', task.context?.mode || '未知'],
      ];
      for (const [label, value] of fields) {
        const field = this.element('div', 'detail-field');
        field.append(this.element('span', '', label), this.element('strong', '', value));
        grid.append(field);
      }
      body.append(grid);
      const promptSection = this.element('section', 'detail-section');
      promptSection.append(
        this.element('h3', '', '任务'),
        this.element('div', 'result-block', task.message || '未记录')
      );
      body.append(promptSection);
      if (task.result?.text || task.error) {
        const resultSection = this.element('section', 'detail-section');
        resultSection.append(
          this.element('h3', '', task.error ? '错误' : '结果'),
          this.element('div', 'result-block', task.error || task.result.text)
        );
        body.append(resultSection);
      }
      const actions = this.refs['task-detail-actions'];
      actions.replaceChildren();
      if (this.state.history.items.some((item) => item.taskId === task.taskId)) {
        const replay = this.button('查看回放', 'button button-quiet', () => this.loadReplay(task));
        actions.append(replay);
      }
      actions.append(
        this.button('关闭', 'button button-quiet', () => this.refs['task-detail-dialog'].close())
      );
    }

    async refreshTaskDetail(task) {
      try {
        const payload = await this.api.request(`/api/task/${encodeURIComponent(task.taskId)}`);
        if (!this.refs['task-detail-dialog'].open) return;
        if (this.refs['task-detail-title'].textContent !== `任务 ${task.taskId}`) return;
        const exact = State.normalizeTask(
          {
            ...payload,
            task: task.message || payload?.task || payload?.message,
            context: task.context,
          },
          task
        );
        if (exact) this.renderTaskDetail(exact);
      } catch (error) {
        this.dispatch({
          type: 'DIAGNOSTIC',
          code: 'task_detail_refresh_failed',
          detail: { taskId: task.taskId, status: error?.status || 0 },
        });
      }
    }

    async loadReplay(task) {
      try {
        const replay = await this.api.request(
          `/api/tasks/${encodeURIComponent(task.taskId)}/replay`
        );
        const section = this.element('section', 'detail-section');
        section.append(
          this.element('h3', '', '持久化回放'),
          this.element('div', 'result-block', JSON.stringify(replay, null, 2))
        );
        this.refs['task-detail-body'].append(section);
      } catch (error) {
        this.notice(`replay-${task.taskId}`, 'warning', '回放不可用', safeErrorMessage(error));
      }
    }

    button(label, className, handler) {
      const button = this.element('button', className, label);
      button.type = 'button';
      button.addEventListener('click', handler);
      return button;
    }

    render() {
      this.renderConnection();
      this.renderContext();
      this.renderNotices();
      this.renderTaskGroups();
      this.renderHistory();
      this.renderDiagnostics();
    }

    renderConnection() {
      const auth = this.state.connection.auth;
      const socket = this.state.connection.socket;
      let label = '未连接';
      let tone = 'neutral';
      if (auth === 'checking') label = '正在验证';
      else if (auth === 'ready' && socket === 'open') {
        label = '已连接';
        tone = 'success';
      } else if (auth === 'ready') {
        label = 'HTTP 降级';
        tone = 'warning';
      } else if (auth === 'unavailable') {
        label = '网关不可用';
        tone = 'danger';
      } else if (auth === 'locked') {
        label = '需要连接';
        tone = 'warning';
      }
      this.refs['runtime-status'].dataset.tone = tone;
      this.refs['runtime-status-label'].textContent = label;
      const locked = auth !== 'ready';
      this.refs['connection-banner'].hidden = !locked;
      this.refs['connection-banner-copy'].textContent =
        auth === 'locked'
          ? '输入当前网关令牌；令牌仅保存在此标签页。'
          : '正在核对本机网关与 TraeCN 状态。';
      this.refs['open-connection'].textContent = auth === 'ready' ? '连接设置' : '连接';
    }

    renderSelect(select, options, selected, placeholder) {
      const current = selected || '';
      select.replaceChildren();
      const empty = this.element('option', '', placeholder);
      empty.value = '';
      select.append(empty);
      for (const option of options) {
        const node = this.element('option', '', option.label);
        node.value = option.value;
        if (option.value === current) node.selected = true;
        select.append(node);
      }
      if (current && !options.some((option) => option.value === current)) {
        const unknown = this.element('option', '', current);
        unknown.value = current;
        unknown.selected = true;
        select.append(unknown);
      }
    }

    renderContext() {
      const workspace = this.catalog.workspace;
      const verified = workspace?.verified === true;
      const ready = this.state.connection.auth === 'ready';
      const path = workspace?.rootPath || workspace?.selectedPath || this.state.context.workspace;
      this.refs['workspace-name'].textContent = workspace?.folderName || basename(path);
      this.refs['workspace-path'].textContent = path || '尚未验证精确路径';
      this.refs['header-workspace'].textContent = verified ? basename(path) : '工作区尚未验证';
      this.refs['context-freshness'].textContent = verified ? '精确路径已验证' : '等待验证';
      this.refs['composer-context-lock'].textContent = verified
        ? '上下文已锁定到提交'
        : '上下文未就绪';
      this.renderSelect(
        this.refs['model-select'],
        this.catalog.models.map((model) => ({ value: model, label: model })),
        this.state.context.model,
        '选择模型'
      );
      this.renderSelect(
        this.refs['mode-select'],
        [
          { value: 'solo', label: 'SOLO' },
          { value: 'ide', label: 'IDE / Agent' },
        ],
        this.state.context.mode,
        '选择模式'
      );
      const conversations = this.catalog.conversations.map((item) => ({
        value: item.id,
        label: item.title || item.id,
      }));
      if (this.state.context.mode === 'solo')
        conversations.unshift({ value: '__new__', label: '+ 新建对话' });
      this.renderSelect(
        this.refs['conversation-select'],
        conversations,
        this.state.context.conversation,
        '使用当前对话'
      );
      this.refs['open-workspace'].disabled = !ready;
      this.refs['model-select'].disabled = !ready || this.catalog.models.length === 0;
      this.refs['mode-select'].disabled = !ready;
      this.refs['conversation-select'].disabled = !ready || this.state.context.mode !== 'solo';
      const canSubmit = ready && verified;
      this.refs['task-message'].disabled = !canSubmit;
      this.refs['submit-task'].disabled = !canSubmit || !this.refs['task-message'].value.trim();
      this.refs['submit-hint'].textContent = canSubmit
        ? '任务将绑定当前精确上下文'
        : '连接并验证工作区后可提交';
      this.refs['task-message'].oninput = () => {
        this.refs['submit-task'].disabled = !canSubmit || !this.refs['task-message'].value.trim();
      };
    }

    renderNotices() {
      const stack = this.refs['notice-stack'];
      stack.replaceChildren();
      for (const notice of this.state.ui.notices) {
        const node = this.element('article', 'notice');
        node.dataset.tone = notice.tone;
        const copy = this.element('div');
        copy.append(
          this.element('strong', '', notice.title),
          this.element('div', '', notice.message)
        );
        const dismiss = this.button('关闭', 'button button-quiet', () =>
          this.dispatch({ type: 'DISMISS_NOTICE', id: notice.id })
        );
        node.append(copy, dismiss);
        stack.append(node);
      }
    }

    renderTaskGroups() {
      const attention = State.selectAttentionTasks(this.state);
      const active = State.selectActiveTasks(this.state);
      const terminal = State.selectTerminalTasks(this.state).slice(0, 8);
      this.refs['attention-section'].hidden = attention.length === 0;
      this.refs['attention-count'].textContent = String(attention.length);
      this.refs['active-count'].textContent = String(active.length);
      this.renderTaskList(this.refs['attention-list'], attention, true, '没有待处理交互');
      this.renderTaskList(this.refs['active-task-list'], active, false, '没有进行中的任务');
      this.renderTaskList(this.refs['result-task-list'], terminal, false, '尚无结果');
    }

    renderTaskList(container, tasks, attention, emptyCopy) {
      container.replaceChildren();
      if (tasks.length === 0) {
        const empty = this.element('article', 'empty-card');
        empty.append(this.element('span', 'empty-glyph', attention ? '!' : '·'));
        const copy = this.element('div');
        copy.append(
          this.element('strong', '', emptyCopy),
          this.element('p', '', '网关状态变化会在这里更新。')
        );
        empty.append(copy);
        container.append(empty);
        return;
      }
      for (const task of tasks) container.append(this.renderTaskCard(task));
    }

    renderTaskCard(task) {
      const card = this.element('article', 'task-card');
      card.dataset.status = task.status;
      const header = this.element('div', 'task-card-header');
      const title = this.element('div', 'task-card-title');
      title.append(
        this.element('strong', '', compactTaskMessage(task)),
        this.element('span', 'task-id', task.taskId)
      );
      header.append(
        title,
        this.element('span', 'task-state', STATUS_LABELS[task.status] || task.status)
      );
      card.append(header);
      const context = this.element('div', 'task-context-row');
      const contextValues = [
        task.context?.model,
        task.context?.mode,
        task.context?.workspace ? basename(task.context.workspace) : null,
        task.stale ? '状态可能过期' : null,
      ].filter(Boolean);
      for (const value of contextValues) context.append(this.element('span', '', value));
      card.append(context);
      if (task.status === 'approval_required') this.renderInteraction(card, task);
      else if (task.result?.text || task.error)
        card.append(this.element('p', 'task-summary', task.error || task.result.text));
      const actions = this.element('div', 'task-card-actions');
      if (State.isActiveStatus(task.status)) {
        actions.append(
          this.button('刷新', 'button button-quiet', () => this.fetchTask(task.taskId))
        );
        actions.append(
          this.button('取消', 'button button-danger', () => this.taskAction(task, 'cancel'))
        );
      }
      if (task.status === 'awaiting_review') {
        actions.append(
          this.button('拒绝', 'button button-danger', () =>
            this.taskAction(task, 'review', {
              decision: 'reject',
              notes: 'Rejected from Web Control Console',
            })
          )
        );
        actions.append(
          this.button('继续', 'button button-quiet', () =>
            this.taskAction(task, 'review', {
              decision: 'continue',
              notes: 'Continue from Web Control Console',
            })
          )
        );
        actions.append(
          this.button('批准结果', 'button button-primary', () =>
            this.taskAction(task, 'review', {
              decision: 'approve',
              notes: 'Approved from Web Control Console',
            })
          )
        );
      }
      actions.append(
        this.button('详情', 'button button-quiet', (event) =>
          this.openTaskDetail(task, event.currentTarget)
        )
      );
      card.append(actions);
      return card;
    }

    renderInteraction(card, task) {
      const interaction = task.interaction || {};
      const form = this.element('div', 'interaction-form');
      if (interaction.question)
        form.append(this.element('p', 'task-summary', interaction.question));
      const options = interaction.options?.length ? interaction.options : interaction.buttons;
      if (Array.isArray(options) && options.length > 0) {
        const row = this.element('div', 'interaction-options');
        for (const option of options) {
          row.append(
            this.button(option.label, 'button button-quiet', () =>
              this.resolveInteraction(task, 'answer', { answer: option.label })
            )
          );
        }
        form.append(row);
      }
      if (interaction.command) {
        form.append(this.element('div', 'command-block', interaction.command));
        if (interaction.riskReasons?.length)
          form.append(this.element('p', 'task-summary', interaction.riskReasons.join(' · ')));
        const reason = this.element('input', 'approval-reason');
        reason.type = 'text';
        reason.maxLength = 500;
        reason.placeholder = '填写批准理由（1–500 字）';
        reason.setAttribute('aria-label', '命令批准理由');
        const riskLabel = this.element('label', 'check-control');
        const acknowledge = this.element('input');
        acknowledge.type = 'checkbox';
        riskLabel.append(acknowledge, this.element('span', '', '我已核对可见命令及其风险'));
        const approve = this.button('批准命令', 'button button-primary', () => {
          if (!acknowledge.checked || !reason.value.trim()) {
            this.notice(
              `approval-context-${task.taskId}`,
              'warning',
              '需要明确授权上下文',
              '核对风险并填写批准理由后才能批准命令。'
            );
            return;
          }
          this.resolveInteraction(task, 'approve', {
            expectedCommand: interaction.command,
            acknowledgeRisk: true,
            reason: reason.value.trim(),
          });
        });
        form.append(reason, riskLabel, approve);
      }
      const decisions = this.element('div', 'interaction-options');
      decisions.append(
        this.button('拒绝', 'button button-danger', () => this.resolveInteraction(task, 'deny')),
        this.button('关闭弹窗', 'button button-quiet', () =>
          this.resolveInteraction(task, 'dismiss')
        )
      );
      form.append(decisions);
      card.append(form);
    }

    renderHistory() {
      const history = this.state.history;
      this.refs['history-health'].textContent = history.loaded
        ? `${history.items.length} 条已加载`
        : '未加载';
      const list = this.refs['history-list'];
      list.replaceChildren();
      if (history.items.length === 0)
        list.append(
          this.element(
            'p',
            'rail-empty',
            history.loaded ? '没有持久化任务。' : '连接后加载最近任务。'
          )
        );
      for (const item of history.items) {
        const button = this.button('', 'history-item', (event) =>
          this.openTaskDetail(item, event.currentTarget)
        );
        button.setAttribute('aria-label', `查看任务 ${item.taskId}`);
        button.append(this.element('strong', '', compactTaskMessage(item)));
        const meta = this.element('span', 'history-meta');
        meta.append(
          this.element('span', '', STATUS_LABELS[item.status] || item.status),
          this.element('span', '', formattedTime(item.createdAt || item.createdAtMs))
        );
        button.append(meta);
        list.append(button);
      }
      const pagination = history.pagination || {};
      this.refs['load-more-history'].disabled = !pagination.hasNext;
    }

    renderDefinitionList(node, entries) {
      node.replaceChildren();
      for (const [label, value] of entries) {
        node.append(this.element('dt', '', label), this.element('dd', '', value ?? '未知'));
      }
    }

    renderDiagnostics() {
      const runtime = this.state.runtime || {};
      const readiness = this.catalog.readiness || {};
      this.renderDefinitionList(this.refs['runtime-diagnostics'], [
        [
          'Gateway',
          runtime.status ||
            runtime.state ||
            (this.state.connection.auth === 'ready' ? 'reachable' : 'unknown'),
        ],
        ['WebSocket', this.state.connection.socket],
        ['TraeCN ready', readiness.ready ?? readiness.success ?? 'unknown'],
        ['Workspace verified', this.catalog.workspace?.verified ?? false],
        ['Model', this.state.context.model || 'unknown'],
        ['Mode', this.state.context.mode || 'unknown'],
      ]);
      this.renderDefinitionList(this.refs['durability-diagnostics'], [
        ['History loaded', this.state.history.loaded],
        ['History items', this.state.history.items.length],
        ['Active tasks', State.selectActiveTasks(this.state).length],
        ['Attention tasks', State.selectAttentionTasks(this.state).length],
        ['Client diagnostics', this.state.ui.diagnostics.length],
      ]);
      const metricCount =
        this.catalog.metrics && typeof this.catalog.metrics === 'object'
          ? Object.keys(this.catalog.metrics).length
          : 0;
      const openapiPaths = this.catalog.openapi?.paths
        ? Object.keys(this.catalog.openapi.paths).length
        : 0;
      const diffCount =
        this.catalog.configDiff && typeof this.catalog.configDiff === 'object'
          ? Object.keys(this.catalog.configDiff).length
          : 0;
      this.refs['metrics-diagnostics'].textContent =
        `Metrics：${metricCount} 个顶层字段 · OpenAPI：${openapiPaths} 条路径 · Config diff：${diffCount} 个顶层字段。敏感值不会呈现在此面板。`;
    }

    openAdvanced(trigger) {
      this.lastFocus = trigger || this.document.activeElement;
      this.drawerOpen = true;
      this.refs['advanced-drawer'].setAttribute('aria-hidden', 'false');
      const close = this.refs['advanced-drawer'].querySelector('.icon-button');
      if (close) this.root.setTimeout(() => close.focus(), 0);
    }

    closeAdvanced() {
      if (!this.drawerOpen) return;
      this.drawerOpen = false;
      this.refs['advanced-drawer'].setAttribute('aria-hidden', 'true');
      if (this.lastFocus?.isConnected) this.lastFocus.focus();
      this.lastFocus = null;
    }

    handleGlobalKeydown(event) {
      if (event.key === 'Escape' && this.drawerOpen) {
        event.preventDefault();
        this.closeAdvanced();
        return;
      }
      if (event.key === 'Escape') {
        const openDialog = this.document.querySelector('dialog[open]');
        if (openDialog) {
          event.preventDefault();
          openDialog.close();
          return;
        }
      }
      if (event.key !== 'Tab' || !this.drawerOpen) return;
      const focusable = Array.from(
        this.refs['advanced-drawer'].querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
        )
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && this.document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && this.document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    handleVisibilityChange() {
      if (this.document.hidden) {
        this.stopRealtime();
        this.dispatch({ type: 'SOCKET_CLOSED', attempt: this.reconnectAttempt });
      } else if (!this.disconnectedByUser && this.state.connection.auth === 'ready') {
        this.hydrate().then(() => this.openSocket());
      }
    }

    async downloadProtectedJson(event, path, filename) {
      event.preventDefault();
      try {
        const payload = await this.api.request(path);
        const blob = new this.root.Blob([JSON.stringify(payload, null, 2)], {
          type: 'application/json',
        });
        const url = this.root.URL.createObjectURL(blob);
        const anchor = this.element('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        this.root.URL.revokeObjectURL(url);
      } catch (error) {
        this.notice(
          'openapi-download-failed',
          'warning',
          'OpenAPI 下载失败',
          safeErrorMessage(error)
        );
      }
    }
  }

  async function bootstrap(options = {}) {
    if (!State) throw new Error('TraecnConsoleState is required');
    const root = options.root;
    if (!root?.document || !root?.location || typeof root.fetch !== 'function') {
      throw new Error('Browser dependencies are unavailable');
    }
    const controller = new ConsoleController({ root });
    await controller.init();
    return controller;
  }

  return {
    ApiError,
    ConsoleController,
    LEGACY_TOKEN_KEY,
    RECONNECT_DELAYS_MS,
    SESSION_TOKEN_KEY,
    WS_BEARER_PROTOCOL_PREFIX,
    WS_PUBLIC_PROTOCOL,
    basename,
    bootstrap,
    buildWebSocketUrl,
    createApiClient,
    createIdempotencyKey,
    createTokenStore,
    encodeUtf8Base64Url,
    listFromModels,
    reconnectDelay,
    safeErrorMessage,
    terminalHistoryTasks,
    websocketProtocols,
  };
});
