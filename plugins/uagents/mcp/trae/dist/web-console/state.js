(function attachTraecnConsoleState(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TraecnConsoleState = api;
})(typeof globalThis === 'object' ? globalThis : this, function createTraecnConsoleState() {
  'use strict';

  const STATUS_ALIASES = Object.freeze({
    accepted: 'queued',
    completed: 'done',
    failed: 'error',
    running: 'executing',
    pending: 'queued',
  });
  const TERMINAL_STATUSES = new Set([
    'done',
    'error',
    'cancelled',
    'queue_timeout',
    'review_rejected',
  ]);
  const ATTENTION_STATUSES = new Set(['approval_required', 'awaiting_review']);
  const ACTIVE_STATUSES = new Set(['queued', 'executing', 'approval_required', 'awaiting_review']);
  const STATUS_PRIORITY = Object.freeze({
    approval_required: 0,
    awaiting_review: 1,
    executing: 2,
    queued: 3,
    error: 4,
    queue_timeout: 5,
    review_rejected: 6,
    cancelled: 7,
    done: 8,
    unknown: 9,
  });
  const MAX_DIAGNOSTICS = 20;
  const MAX_NOTICES = 8;
  const SENSITIVE_KEY = /authorization|token|password|secret|credential|cookie/i;

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value || {}, key);
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function asString(value, fallback = null) {
    if (typeof value !== 'string') return fallback;
    const normalized = value.trim();
    return normalized || fallback;
  }

  function asNumber(value, fallback = null) {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : fallback;
  }

  function toTimestamp(value, fallback = 0) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fallback;
  }

  function normalizeStatus(status, fallback = 'unknown') {
    const value = asString(status, fallback);
    return STATUS_ALIASES[value] || value;
  }

  function isTerminalStatus(status) {
    return TERMINAL_STATUSES.has(normalizeStatus(status));
  }

  function isAttentionStatus(status) {
    return ATTENTION_STATUSES.has(normalizeStatus(status));
  }

  function isActiveStatus(status) {
    return ACTIVE_STATUSES.has(normalizeStatus(status));
  }

  function normalizeOption(option) {
    if (typeof option === 'string') {
      const label = asString(option);
      return label ? { label, description: null } : null;
    }
    const value = asObject(option);
    const label = asString(value.label || value.text || value.value);
    if (!label) return null;
    return {
      label,
      description: asString(value.description || value.detail),
    };
  }

  function normalizeOptions(value) {
    if (!Array.isArray(value)) return [];
    return value.map(normalizeOption).filter(Boolean).slice(0, 40);
  }

  function normalizeContext(payload, previous = {}) {
    const value = asObject(payload);
    const explicit = asObject(value.context);
    const metadata = asObject(value.metadata);
    const soloChat = asObject(value.soloChat || metadata.soloChat);
    return {
      workspace: asString(
        explicit.workspace || value.workspace || value.projectPath || metadata.projectPath,
        previous.workspace || null
      ),
      model: asString(
        explicit.model ||
          value.model ||
          value.currentModel ||
          value.desiredModel ||
          metadata.currentModel,
        previous.model || null
      ),
      mode: asString(explicit.mode || value.mode || metadata.mode, previous.mode || null),
      conversation: asString(
        explicit.conversation ||
          value.conversation ||
          value.conversationId ||
          soloChat.titleIncludes ||
          soloChat.textIncludes,
        previous.conversation || null
      ),
    };
  }

  function normalizeResult(payload, previous = null) {
    const value = asObject(payload);
    const explicit = hasOwn(value, 'result') ? value.result : previous;
    if (explicit === null || explicit === undefined) return previous || null;
    if (typeof explicit === 'string') {
      return { text: explicit, stable: null, elapsedMs: null, timedOut: false };
    }
    const result = asObject(explicit);
    return {
      ...asObject(previous),
      ...result,
      text: asString(result.text, asString(asObject(previous).text, '')) || '',
      stable:
        typeof result.stable === 'boolean' ? result.stable : (asObject(previous).stable ?? null),
      elapsedMs: asNumber(result.elapsedMs, asNumber(asObject(previous).elapsedMs)),
      timedOut: result.timedOut === true,
    };
  }

  function normalizeInteraction(payload, status, previous = null) {
    if (status !== 'approval_required') return null;
    const value = asObject(payload);
    const result = asObject(value.result);
    const prior = asObject(previous);
    return {
      interactionRequestId: asString(
        value.interactionRequestId || result.interactionRequestId,
        prior.interactionRequestId || null
      ),
      dialogType: asString(result.dialogType || value.dialogType, prior.dialogType || null),
      question: asString(result.question || value.question, prior.question || null),
      command: asString(result.command || value.command, prior.command || null),
      commandRisk: asString(result.commandRisk || value.commandRisk, prior.commandRisk || null),
      riskReasons: Array.isArray(result.riskReasons)
        ? result.riskReasons
            .map((item) => asString(item))
            .filter(Boolean)
            .slice(0, 20)
        : prior.riskReasons || [],
      options: normalizeOptions(result.options || value.options || prior.options),
      buttons: normalizeOptions(result.buttons || value.buttons || prior.buttons),
    };
  }

  function taskRevision(payload, previous = null) {
    const value = asObject(payload);
    const explicit = asNumber(value.revision ?? value.sequence ?? value.eventSequence);
    if (explicit !== null) return explicit;
    return toTimestamp(
      value.updatedAt || value.timestamp || value.completedAt,
      previous ? previous._revision || 0 : 0
    );
  }

  function normalizeTask(payload, previous = null) {
    const value = asObject(payload);
    const prior = asObject(previous);
    const taskId = asString(value.taskId || value.id, prior.taskId || null);
    if (!taskId) return null;

    const status = normalizeStatus(value.status, prior.status || 'unknown');
    const revision = taskRevision(value, prior);
    if (prior.taskId && revision && prior._revision && revision < prior._revision) return previous;
    if (prior.taskId && isTerminalStatus(prior.status) && !isTerminalStatus(status))
      return previous;

    const createdAt = hasOwn(value, 'createdAt')
      ? value.createdAt
      : prior.createdAt || value.timestamp || null;
    const createdAtMs = toTimestamp(createdAt, asNumber(value.createdAtMs, prior.createdAtMs || 0));
    const result = normalizeResult(value, prior.result || null);
    const message = asString(
      value.task || value.message || value.title || value.summary,
      prior.message || null
    );
    const error = hasOwn(value, 'error')
      ? asString(value.error || asObject(value.error).message)
      : prior.error || null;

    return {
      ...prior,
      taskId,
      status,
      message,
      createdAt,
      createdAtMs,
      completedAt: hasOwn(value, 'completedAt') ? value.completedAt : prior.completedAt || null,
      elapsed: asNumber(value.elapsed, prior.elapsed || null),
      progress: asNumber(value.progress, prior.progress || null),
      result,
      error,
      reviewRequired: value.reviewRequired === true || status === 'awaiting_review',
      context: normalizeContext(value, prior.context),
      interaction: normalizeInteraction(value, status, prior.interaction),
      queueDetails: hasOwn(value, 'queueDetails')
        ? asObject(value.queueDetails)
        : prior.queueDetails || null,
      stale: value.stale === true,
      _revision: Math.max(revision, prior._revision || 0),
    };
  }

  function normalizeHistoryItem(payload) {
    const task = normalizeTask(payload);
    if (!task) return null;
    return {
      ...task,
      status: normalizeStatus(payload.status, task.status),
      hasResult: payload.hasResult === true || Boolean(task.result),
      stepCount: asNumber(payload.stepCount, 0),
      sessionId: asString(payload.sessionId),
    };
  }

  function createInitialState() {
    return {
      connection: {
        auth: 'unknown',
        socket: 'closed',
        stale: true,
        lastSuccessAt: null,
        reconnectAttempt: 0,
      },
      runtime: null,
      context: {
        workspace: null,
        model: null,
        mode: null,
        conversation: null,
      },
      tasks: {},
      history: {
        items: [],
        pagination: null,
        loaded: false,
      },
      ui: {
        notices: [],
        diagnostics: [],
      },
    };
  }

  function withTask(state, payload) {
    const taskId = asString(asObject(payload).taskId || asObject(payload).id);
    if (!taskId) return state;
    const previous = state.tasks[taskId] || null;
    const task = normalizeTask(payload, previous);
    if (!task || task === previous) return state;
    return {
      ...state,
      tasks: {
        ...state.tasks,
        [taskId]: task,
      },
    };
  }

  function sanitizeDiagnostic(value, depth = 0) {
    if (depth > 3) return '[TRUNCATED]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value.slice(0, 500);
    if (typeof value !== 'object') return value;
    if (Array.isArray(value))
      return value.slice(0, 20).map((item) => sanitizeDiagnostic(item, depth + 1));
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 30)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeDiagnostic(item, depth + 1);
    }
    return output;
  }

  function reduceState(currentState, action) {
    const state = currentState || createInitialState();
    const input = asObject(action);
    switch (input.type) {
      case 'CONNECTION':
        return {
          ...state,
          connection: {
            ...state.connection,
            ...asObject(input.connection),
          },
        };
      case 'SOCKET_OPEN':
        return {
          ...state,
          connection: {
            ...state.connection,
            socket: 'open',
            stale: false,
            reconnectAttempt: 0,
            lastSuccessAt: input.at || state.connection.lastSuccessAt,
          },
        };
      case 'SOCKET_CLOSED':
        return {
          ...state,
          connection: {
            ...state.connection,
            socket: 'closed',
            stale: true,
            reconnectAttempt: asNumber(input.attempt, state.connection.reconnectAttempt),
          },
          tasks: Object.fromEntries(
            Object.entries(state.tasks).map(([taskId, task]) => [
              taskId,
              isActiveStatus(task.status) ? { ...task, stale: true } : task,
            ])
          ),
        };
      case 'RUNTIME':
        return { ...state, runtime: asObject(input.runtime) };
      case 'CONTEXT':
        return {
          ...state,
          context: {
            ...state.context,
            ...asObject(input.context),
          },
        };
      case 'UPSERT_TASK':
        return withTask(state, input.task);
      case 'HYDRATE_TASKS': {
        let next = state;
        const seen = new Set();
        for (const payload of Array.isArray(input.tasks) ? input.tasks : []) {
          const taskId = asString(asObject(payload).taskId || asObject(payload).id);
          if (taskId) seen.add(taskId);
          next = withTask(next, { ...asObject(payload), stale: false });
        }
        if (input.authoritativeActive === true) {
          const tasks = { ...next.tasks };
          for (const [taskId, task] of Object.entries(tasks)) {
            if (isActiveStatus(task.status) && !seen.has(taskId)) {
              tasks[taskId] = { ...task, stale: true };
            }
          }
          next = { ...next, tasks };
        }
        return next;
      }
      case 'REMOVE_TASK': {
        const taskId = asString(input.taskId);
        if (!taskId || !state.tasks[taskId]) return state;
        const tasks = { ...state.tasks };
        delete tasks[taskId];
        return { ...state, tasks };
      }
      case 'HISTORY': {
        const page = asObject(input.page);
        const incoming = (Array.isArray(page.tasks) ? page.tasks : [])
          .map(normalizeHistoryItem)
          .filter(Boolean);
        const items =
          input.append === true
            ? Array.from(
                new Map(
                  [...state.history.items, ...incoming].map((item) => [item.taskId, item])
                ).values()
              )
            : incoming;
        return {
          ...state,
          history: {
            items,
            pagination: asObject(page.pagination),
            loaded: true,
          },
        };
      }
      case 'NOTICE': {
        const notice = {
          id: asString(input.notice?.id, `notice-${Date.now()}`),
          tone: asString(input.notice?.tone, 'neutral'),
          title: asString(input.notice?.title, 'Notice'),
          message: asString(input.notice?.message, '') || '',
        };
        return {
          ...state,
          ui: {
            ...state.ui,
            notices: [notice, ...state.ui.notices.filter((item) => item.id !== notice.id)].slice(
              0,
              MAX_NOTICES
            ),
          },
        };
      }
      case 'DISMISS_NOTICE':
        return {
          ...state,
          ui: {
            ...state.ui,
            notices: state.ui.notices.filter((item) => item.id !== input.id),
          },
        };
      case 'DIAGNOSTIC': {
        const entry = {
          at: input.at || Date.now(),
          code: asString(input.code, 'client_event'),
          detail: sanitizeDiagnostic(input.detail),
        };
        return {
          ...state,
          ui: {
            ...state.ui,
            diagnostics: [entry, ...state.ui.diagnostics].slice(0, MAX_DIAGNOSTICS),
          },
        };
      }
      case 'LOCK_PROTECTED':
        return {
          ...state,
          connection: {
            ...state.connection,
            auth: 'locked',
            socket: 'closed',
            stale: true,
          },
          runtime: null,
          context: createInitialState().context,
          history: createInitialState().history,
          tasks: Object.fromEntries(
            Object.entries(state.tasks).map(([taskId, task]) => [taskId, { ...task, stale: true }])
          ),
        };
      default:
        return state;
    }
  }

  function classifySocketEvent(event) {
    const value = asObject(event);
    const nested = value.type === 'event' ? asObject(value.data) : value;
    const eventType = value.type === 'event' ? asString(value.eventType) : asString(value.type);
    const taskId = asString(nested.taskId || value.taskId);

    if (eventType === 'connected') return { kind: 'connected', taskId: null, payload: null };
    if (eventType === 'subscribed' || eventType === 'unsubscribed' || eventType === 'pong') {
      return { kind: 'control', taskId, payload: null };
    }
    if (eventType === 'taskUpdate') {
      return { kind: 'task', taskId, payload: { ...value, taskId } };
    }
    if (
      eventType === 'taskStatusChanged' ||
      eventType === 'approvalRequired' ||
      eventType === 'task_completed' ||
      eventType === 'task_failed' ||
      eventType === 'task_cancelled' ||
      eventType === 'review_required'
    ) {
      return {
        kind: 'refresh',
        taskId,
        payload: { ...nested, ...value, taskId, timestamp: value.timestamp },
      };
    }
    if (eventType === 'aiResponse') {
      return { kind: 'refresh', taskId, payload: { ...value, taskId } };
    }
    return { kind: 'unknown', taskId, payload: sanitizeDiagnostic(value) };
  }

  function reduceSocketEvent(state, event) {
    const classified = classifySocketEvent(event);
    if (classified.kind === 'connected') {
      return reduceState(state, { type: 'SOCKET_OPEN', at: Date.now() });
    }
    if (classified.kind === 'task') {
      return reduceState(state, { type: 'UPSERT_TASK', task: classified.payload });
    }
    if (classified.kind === 'refresh' && classified.taskId) {
      return reduceState(state, { type: 'UPSERT_TASK', task: classified.payload });
    }
    if (classified.kind === 'unknown') {
      return reduceState(state, {
        type: 'DIAGNOSTIC',
        code: 'unknown_socket_event',
        detail: classified.payload,
      });
    }
    return state;
  }

  function sortedTasks(state) {
    return Object.values(asObject(state?.tasks)).sort((left, right) => {
      const priority = (STATUS_PRIORITY[left.status] ?? 99) - (STATUS_PRIORITY[right.status] ?? 99);
      if (priority !== 0) return priority;
      if (isTerminalStatus(left.status)) return (right.createdAtMs || 0) - (left.createdAtMs || 0);
      return (left.createdAtMs || 0) - (right.createdAtMs || 0);
    });
  }

  function selectAttentionTasks(state) {
    return sortedTasks(state).filter((task) => isAttentionStatus(task.status));
  }

  function selectActiveTasks(state) {
    return sortedTasks(state).filter(
      (task) => isActiveStatus(task.status) && !isAttentionStatus(task.status)
    );
  }

  function selectTerminalTasks(state) {
    return sortedTasks(state).filter((task) => isTerminalStatus(task.status));
  }

  return {
    ACTIVE_STATUSES,
    ATTENTION_STATUSES,
    MAX_DIAGNOSTICS,
    MAX_NOTICES,
    STATUS_ALIASES,
    TERMINAL_STATUSES,
    classifySocketEvent,
    createInitialState,
    isActiveStatus,
    isAttentionStatus,
    isTerminalStatus,
    normalizeContext,
    normalizeHistoryItem,
    normalizeStatus,
    normalizeTask,
    reduceSocketEvent,
    reduceState,
    sanitizeDiagnostic,
    selectActiveTasks,
    selectAttentionTasks,
    selectTerminalTasks,
    sortedTasks,
  };
});
