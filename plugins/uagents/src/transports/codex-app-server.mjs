import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createInterface } from 'node:readline';
import { childEnvironment } from '../runtime/child-environment.mjs';
import { buildCodexPrompt } from './codex-process.mjs';
import { createCodexAppServerProcessEvidence } from './codex-app-server-process.mjs';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const CLOSE_GRACE_MS = 2_000;
const HISTORY_PAGE_SIZE = 64;
const MAX_HISTORY_PAGES = 64;

// One native Turn per process. The public app-server route remains opt-in.
export function invokeCodexAppServerTurn({ entry, request, workspace, beforeSend = () => {},
  onAccepted = () => {}, session = null, spawnImpl = spawn, signal = null, isCancelRequested = null,
  closeGraceMs = CLOSE_GRACE_MS, processEvidence = null, appServerArgs = [] } = {}) {
  if (!Array.isArray(appServerArgs) || appServerArgs.some(arg => typeof arg !== 'string')) {
    return Promise.resolve({ status: 'failed', error: 'invalid_native_args', submission: 'not_sent' });
  }
  if (session && (!['continue', 'fork'].includes(session.action) ||
      !session.native_session_id || !session.native_turn_id)) {
    return Promise.resolve({ status: 'failed', error: 'invalid_native_session', submission: 'not_sent' });
  }
  if (signal?.aborted || isCancelRequested?.()) {
    return Promise.resolve({ status: 'cancelled', error: 'cancelled_before_send', submission: 'not_sent' });
  }
  return new Promise(resolve => {
    const argv = [entry, 'app-server', '--stdio', ...appServerArgs];
    let evidence;
    try { evidence = createCodexAppServerProcessEvidence({ ...processEvidence, entry, workspace, argv }); }
    catch (cause) {
      resolve({ status: 'failed', error: cause?.message ?? 'native_process_evidence_failed', submission: 'not_sent' });
      return;
    }
    let child;
    try {
      child = spawnImpl(process.execPath, argv, {
        cwd: workspace, windowsHide: true, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      try { evidence?.noSpawn(); } catch {}
      resolve({ status: 'failed', error: 'native_process_error', submission: 'not_sent' });
      return;
    }
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let bytes = 0;
    let phase = 'initialize';
    let threadId = null;
    let turnId = null;
    let turnSent = false;
    let accepted = false;
    let terminal = null;
    let response = '';
    let usage = null;
    let error = null;
    let cancelled = false;
    let interruptSent = false;
    let timedOut = false;
    let forcedTermination = false;
    let finished = false;
    let spawned = false;
    let closing = false;
    let stopping = false;
    let closeTimer = null;
    let forceTimer = null;
    const pendingEvents = [];
    const threadRequestId = session ? 3 : 2;
    const turnRequestId = session ? 4 : 3;
    const interruptRequestId = turnRequestId + 1;
    const sourceTurnsRequestId = interruptRequestId + 1;
    const resumedTurnsRequestId = sourceTurnsRequestId + 1;
    let sourcePageCount = 0;
    let sourceCursor = null;
    const sourceCursors = new Set();
    const sourcePage = () => {
      if (++sourcePageCount > MAX_HISTORY_PAGES || sourceCursor !== null && sourceCursors.has(sourceCursor)) {
        error = 'native_history_incomplete'; stop(); return;
      }
      if (sourceCursor !== null) sourceCursors.add(sourceCursor);
      send(sourceTurnsRequestId, 'thread/turns/list', { threadId: session.native_session_id,
        sortDirection: 'desc', itemsView: 'notLoaded', limit: HISTORY_PAGE_SIZE,
        ...(sourceCursor === null ? {} : { cursor: sourceCursor }) });
    };
    const finish = (launcherCloseConfirmed, processTreeQuiescent = true) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      clearTimeout(forceTimer);
      clearInterval(cancelPoll);
      signal?.removeEventListener?.('abort', cancel);
      const confirmedInterrupt = cancelled && accepted && terminal === 'interrupted' &&
        launcherCloseConfirmed && processTreeQuiescent && !error;
      const status = !turnSent ? cancelled ? 'cancelled' : 'failed'
        : error || forcedTermination || !launcherCloseConfirmed || !processTreeQuiescent ? 'unknown'
          : accepted && terminal === 'completed' && response.trim() ? 'succeeded'
            : accepted && terminal === 'failed' ? 'failed'
              : confirmedInterrupt ? 'cancelled' : 'unknown';
      resolve({ status, error: status === 'succeeded' || status === 'cancelled' && turnSent ? null
        : status === 'failed' && terminal === 'failed' ? 'native_turn_failed'
          : error ?? (!processTreeQuiescent ? 'process_tree_unconfirmed'
            : forcedTermination ? 'native_process_forced_stop'
            : cancelled ? turnSent ? 'cancel_remote_state_unknown' : 'cancelled_before_send'
            : timedOut ? 'native_observation_timeout' : !turnSent ? 'native_preflight_failed'
              : !accepted ? 'native_acceptance_unconfirmed' : !terminal ? 'native_terminal_missing'
                : !response.trim() ? 'native_response_empty' : 'native_close_unconfirmed'),
      submission: turnSent ? accepted ? 'sent' : 'may_have_been_sent' : 'not_sent',
      native_session_id: threadId, native_turn_id: turnId,
      native_status: terminal ?? (accepted ? 'unknown' : null), response, usage,
      launcher_close_confirmed: launcherCloseConfirmed,
      process_tree_quiescent: processTreeQuiescent,
      forced_termination: forcedTermination });
    };
    const forceClose = () => {
      try { evidence?.unknown(); } catch {}
      child.stdin?.destroy?.(); child.stdout?.destroy?.(); child.stderr?.destroy?.();
      child.unref?.(); finish(false, false);
    };
    const terminate = async () => {
      forcedTermination = true;
      try {
        const result = await evidence?.terminate();
        if (result?.kind === 'terminated' || result?.kind === 'already_exited') return;
      } catch {}
      try { child.kill(); } catch {}
    };
    const stop = (graceful = false) => {
      if (finished || closing || stopping) return;
      stopping = true;
      if (graceful) {
        try { child.stdin.end(); } catch {}
        closeTimer = setTimeout(() => {
          void terminate().finally(() => {
            if (!finished && !closing) forceTimer = setTimeout(forceClose, closeGraceMs);
          });
        }, closeGraceMs);
      } else {
        void terminate().finally(() => {
          if (!finished && !closing) closeTimer = setTimeout(forceClose, closeGraceMs);
        });
      }
    };
    const send = (id, method, params) => {
      try { child.stdin.write(`${JSON.stringify({ ...(id === null ? {} : { id }), method, params })}\n`); }
      catch { error ??= 'stdin_failed'; stop(); }
    };
    const requestInterrupt = () => {
      if (!cancelled || !accepted || !turnId || terminal || interruptSent || finished) return;
      interruptSent = true;
      send(interruptRequestId, 'turn/interrupt', { threadId, turnId });
    };
    const cancel = () => {
      if (cancelled || finished) return;
      cancelled = true;
      if (!turnSent) stop();
      else requestInterrupt(); // A missing turn/start reply stays uncertain until the observation deadline.
    };
    const startTurn = () => {
      phase = 'turn';
      try { beforeSend(threadId); }
      catch { error = 'checkpoint_failed'; stop(); return; }
      if (cancelled) { stop(); return; }
      try { evidence?.persist(); }
      catch { error = 'native_process_evidence_failed'; stop(); return; }
      turnSent = true; // The checkpoint precedes any possible turn/start bytes.
      send(turnRequestId, 'turn/start', { threadId, model: request.model_resolved,
        ...(request.request_id ? { clientUserMessageId: request.request_id } : {}),
        input: [{ type: 'text', text: buildCodexPrompt(request, workspace) }] });
    };
    const event = frame => {
      const params = frame.params;
      if (terminal) { error ??= 'invalid_event_order'; stop(); return; }
      if (params?.threadId !== threadId || params?.turnId && params.turnId !== turnId ||
          params?.turn?.id && params.turn.id !== turnId) {
        error ??= 'native_session_mismatch'; stop(); return;
      }
      if (frame.method === 'item/completed' && params.item?.type === 'agentMessage' &&
          typeof params.item.text === 'string') {
        response = params.item.text;
      } else if (frame.method === 'thread/tokenUsage/updated' && params.tokenUsage &&
          typeof params.tokenUsage === 'object') {
        usage = params.tokenUsage;
      } else if (frame.method === 'turn/completed') {
        if (terminal || !['completed', 'failed', 'interrupted'].includes(params.turn?.status)) {
          error ??= 'invalid_event_order'; stop(); return;
        }
        terminal = params.turn.status;
        if (!response && Array.isArray(params.turn.items)) {
          response = params.turn.items.filter(item => item?.type === 'agentMessage' && typeof item.text === 'string')
            .at(-1)?.text ?? '';
        }
        stop(true);
      }
    };
    const line = value => {
      if (!value.trim() || error) return;
      let frame;
      try { frame = JSON.parse(value); }
      catch { error = 'malformed_stream'; stop(); return; }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
        error = 'malformed_stream'; stop(); return;
      }
      if (Object.hasOwn(frame, 'id') && typeof frame.method === 'string') {
        error = frame.method.endsWith('/requestApproval')
          ? 'native_approval_required' : 'native_interaction_required';
        stop(); return;
      }
      if (Object.hasOwn(frame, 'id')) {
        if (frame.error) { error = 'native_rpc_error'; stop(); return; }
        if (frame.id === 1 && phase === 'initialize' && frame.result && typeof frame.result === 'object') {
          send(null, 'initialized', {});
          if (session) {
            phase = 'source';
            send(2, 'thread/read', { threadId: session.native_session_id, includeTurns: false });
          } else {
            phase = 'thread';
            send(threadRequestId, 'thread/start', { cwd: workspace, model: request.model_resolved });
          }
        } else if (frame.id === 2 && phase === 'source') {
          const source = frame.result?.thread;
          if (source?.id !== session.native_session_id) {
            error = 'native_session_mismatch'; stop(); return;
          }
          phase = 'source-turns';
          sourcePage();
        } else if (frame.id === sourceTurnsRequestId && phase === 'source-turns') {
          const turns = frame.result?.data;
          if (!Array.isArray(turns) || turns.length === 0 ||
              turns.some(turn => typeof turn?.id !== 'string' || typeof turn?.status !== 'string')) {
            error = 'native_history_incomplete'; stop(); return;
          }
          if (session.action === 'continue' && sourcePageCount === 1 && turns[0].id !== session.native_turn_id) {
            error = 'native_session_mismatch'; stop(); return;
          }
          const matched = turns.find(turn => turn.id === session.native_turn_id);
          if (!matched) {
            sourceCursor = frame.result?.nextCursor;
            if (typeof sourceCursor === 'string' && sourceCursor) sourcePage();
            else { error = 'native_session_mismatch'; stop(); }
            return;
          }
          if (matched.status !== 'completed') { error = 'native_session_mismatch'; stop(); return; }
          phase = 'thread';
          send(threadRequestId, session.action === 'continue' ? 'thread/resume' : 'thread/fork', {
            threadId: session.native_session_id, cwd: workspace, model: request.model_resolved,
            ...(session.action === 'fork' ? { lastTurnId: session.native_turn_id } : {}),
          });
        } else if (frame.id === threadRequestId && phase === 'thread' && typeof frame.result?.thread?.id === 'string') {
          threadId = frame.result.thread.id;
          if (session && (session.action === 'continue' && threadId !== session.native_session_id ||
              session.action === 'fork' && (threadId === session.native_session_id ||
                frame.result.thread.forkedFromId && frame.result.thread.forkedFromId !== session.native_session_id))) {
            error = 'native_session_mismatch'; stop(); return;
          }
          if (session?.action === 'continue') {
            phase = 'verify-resume';
            send(resumedTurnsRequestId, 'thread/turns/list', { threadId,
              sortDirection: 'desc', itemsView: 'notLoaded', limit: 1 });
          } else startTurn();
        } else if (frame.id === resumedTurnsRequestId && phase === 'verify-resume') {
          const latest = frame.result?.data;
          if (!Array.isArray(latest) || latest.length !== 1 ||
              latest[0]?.id !== session.native_turn_id || latest[0]?.status !== 'completed') {
            error = 'native_session_mismatch'; stop(); return;
          }
          startTurn();
        } else if (frame.id === turnRequestId && phase === 'turn' && typeof frame.result?.turn?.id === 'string') {
          turnId = frame.result.turn.id;
          if (frame.result.turn.status !== 'inProgress' && frame.result.turn.status !== 'completed') {
            error = 'invalid_event_order'; stop(); return;
          }
          try { onAccepted({ session_id: threadId, task_id: turnId, status: 'accepted' }); }
          catch { error = 'checkpoint_failed'; stop(); return; }
          accepted = true;
          phase = 'observe';
          for (const pending of pendingEvents.splice(0)) event(pending);
          requestInterrupt();
        } else if (frame.id === interruptRequestId && phase === 'observe' && interruptSent &&
            frame.result && typeof frame.result === 'object') {
          // An interrupt RPC acknowledgement is not a terminal Turn observation.
        } else { error = 'invalid_event_order'; stop(); }
        return;
      }
      if (typeof frame.method !== 'string') { error = 'malformed_stream'; stop(); return; }
      if (!['item/completed', 'thread/tokenUsage/updated', 'turn/completed'].includes(frame.method)) return;
      if (!accepted) pendingEvents.push(frame);
      else event(frame);
    };
    child.stdout?.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { error = 'output_limit'; stop(); return; }
      buffer += decoder.write(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const current = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        line(current);
      }
    });
    child.stderr?.on('data', () => {});
    child.stdin?.on('error', () => { if (!terminal) { error ??= 'stdin_failed'; stop(); } });
    child.once('error', () => {
      error ??= 'native_process_error';
      if (!spawned) try { evidence?.noSpawn(); } catch {}
      stop();
    });
    child.once('close', async code => {
      if (finished) return;
      closing = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      clearTimeout(forceTimer);
      buffer += decoder.end();
      if (buffer.trim()) line(buffer);
      let treeQuiescent = true;
      try { treeQuiescent = evidence ? spawned ? await evidence.closed(code) : evidence.noSpawn() : true; }
      catch { treeQuiescent = false; }
      finish(true, treeQuiescent);
    });
    child.once('spawn', async () => {
      spawned = true;
      try { await evidence?.inspect(child); }
      catch { error ??= 'native_process_identity_mismatch'; stop(); return; }
      if (!finished && !closing && !cancelled) send(1, 'initialize', { clientInfo: {
        name: 'uagents', title: 'uAgents', version: '0.2.0',
      } });
    });
    if (signal?.aborted) cancel();
    else signal?.addEventListener?.('abort', cancel, { once: true });
    const cancelPoll = setInterval(() => { try { if (isCancelRequested?.()) cancel(); } catch {} }, 100);
    cancelPoll.unref?.();
    const timer = setTimeout(() => { timedOut = true; stop(); }, request.execution.observation_timeout_ms);
  });
}

// Read-only reconciliation for an accepted Turn. A missing or partial native
// record never authorizes replaying its prompt.
export async function readCodexAppServerTurn({ entry, workspace, threadId, turnId = null, clientRequestId = null,
  spawnImpl = spawn, timeoutMs = 30_000 } = {}) {
  let child;
  try {
    child = spawnImpl(process.execPath, [entry, 'app-server', '--stdio'], {
      cwd: workspace, windowsHide: true, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return { type: 'indeterminate', same_native_identity: false, evidence_strength: 1, error: 'native_process_error' };
  }
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  let bytes = 0;
  const failPending = code => {
    for (const waiter of pending.values()) waiter.reject(Object.assign(new Error(code), { code }));
    pending.clear();
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    bytes += Buffer.byteLength(line, 'utf8');
    if (bytes > MAX_OUTPUT_BYTES) { failPending('output_limit'); return; }
    let frame;
    try { frame = JSON.parse(line); }
    catch { failPending('malformed_stream'); return; }
    if (typeof frame?.method === 'string' && Object.hasOwn(frame, 'id')) {
      failPending('native_interaction_required'); return;
    }
    if (!Object.hasOwn(frame ?? {}, 'id')) return;
    const waiter = pending.get(frame.id);
    if (!waiter) return;
    pending.delete(frame.id);
    frame.error ? waiter.reject(Object.assign(new Error('Native app-server RPC failed.'), {
      code: 'native_rpc_error', rpcCode: frame.error.code, rpcMethod: waiter.method,
    }))
      : waiter.resolve(frame.result);
  });
  child.once('error', () => failPending('native_process_error'));
  child.once('close', () => { closed = true; failPending('native_process_exit'); });
  child.stdin?.on('error', () => failPending('stdin_failed'));
  const send = (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ ...(id === null ? {} : { id }), method, params })}\n`);
  };
  const request = (method, params) => {
    const id = nextId++;
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
    try { send(id, method, params); }
    catch { failPending('stdin_failed'); }
    return response;
  };
  const nativeHistoryError = () => Object.assign(new Error('Native history is incomplete.'), { code: 'native_history_incomplete' });
  const readItems = async selectedTurnId => {
    const items = [];
    let cursor = null;
    const seen = new Set();
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      if (cursor !== null && seen.has(cursor)) throw nativeHistoryError();
      if (cursor !== null) seen.add(cursor);
      const response = await request('thread/items/list', { threadId, turnId: selectedTurnId,
        sortDirection: 'asc', limit: HISTORY_PAGE_SIZE, ...(cursor === null ? {} : { cursor }) });
      if (!Array.isArray(response?.data) || response.data.some(row => row?.turnId !== selectedTurnId ||
          !row.item || typeof row.item !== 'object')) throw nativeHistoryError();
      items.push(...response.data.map(row => row.item));
      cursor = response.nextCursor;
      if (cursor === null) return items;
      if (typeof cursor !== 'string' || !cursor || response.data.length === 0) throw nativeHistoryError();
    }
    throw nativeHistoryError();
  };
  const findTurn = async (itemsView = 'notLoaded') => {
    let cursor = null;
    const seen = new Set();
    let match = null;
    try {
      for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
        if (cursor !== null && seen.has(cursor)) throw nativeHistoryError();
        if (cursor !== null) seen.add(cursor);
        const response = await request('thread/turns/list', { threadId, sortDirection: 'desc',
          itemsView, limit: HISTORY_PAGE_SIZE, ...(cursor === null ? {} : { cursor }) });
        if (!Array.isArray(response?.data) || response.data.some(turn =>
            typeof turn?.id !== 'string' || typeof turn?.status !== 'string')) throw nativeHistoryError();
        for (const turn of response.data) {
          if (turnId && turn.id !== turnId) continue;
          const items = itemsView === 'full' ? (() => {
            if (turn.itemsView !== 'full' || !Array.isArray(turn.items) ||
                turn.items.some(item => !item || typeof item !== 'object')) throw nativeHistoryError();
            return turn.items;
          })() : await readItems(turn.id);
          if (turnId) return { turn, items };
          if (items.some(item => item.type === 'userMessage' && item.clientId === clientRequestId)) {
            if (match) return { ambiguous: true };
            match = { turn, items };
          }
        }
        cursor = response.nextCursor;
        if (cursor === null) return match;
        if (typeof cursor !== 'string' || !cursor || response.data.length === 0) throw nativeHistoryError();
      }
    } catch (error) {
      if (itemsView === 'notLoaded' && error?.rpcCode === -32601 &&
          error?.rpcMethod === 'thread/items/list') return findTurn('full');
      throw error;
    }
    throw nativeHistoryError();
  };
  const timer = setTimeout(() => failPending('native_observation_timeout'), timeoutMs);
  let observation;
  try {
    const initialized = await request('initialize', { clientInfo: {
      name: 'uagents', title: 'uAgents', version: '0.2.0',
    } });
    if (!initialized || typeof initialized !== 'object') throw Object.assign(new Error('Invalid initialize response.'), { code: 'invalid_event' });
    send(null, 'initialized', {});
    const read = await request('thread/read', { threadId, includeTurns: false });
    const nativeThread = read?.thread;
    const located = nativeThread?.id === threadId && (turnId || clientRequestId) ? await findTurn() : null;
    const turn = located?.turn;
    if (nativeThread?.id !== threadId || !turn || located?.ambiguous) {
      observation = { type: 'indeterminate', same_native_identity: false, evidence_strength: 1,
        error: turnId ? 'native_session_mismatch' : 'native_turn_unresolved' };
    } else if (turn.status === 'completed') {
      const response = located.items.filter(item => item?.type === 'agentMessage' &&
        typeof item.text === 'string').at(-1)?.text ?? '';
      observation = response.trim()
        ? { type: 'succeeded', same_native_identity: true, evidence_strength: 2,
          native_status: 'completed', native_turn_id: turn.id, response, usage: null,
          model_reported: null, model_verified: false }
        : { type: 'indeterminate', same_native_identity: true, evidence_strength: 1,
          native_status: 'completed', native_turn_id: turn.id, error: 'native_response_empty' };
    } else if (turn.status === 'failed') {
      observation = { type: 'failed', same_native_identity: true, evidence_strength: 2,
        native_status: 'failed', native_turn_id: turn.id, error: 'native_turn_failed' };
    } else if (turn.status === 'interrupted') {
      observation = { type: 'cancelled', same_native_identity: true, evidence_strength: 2,
        native_status: 'interrupted', native_turn_id: turn.id };
    } else {
      observation = { type: 'indeterminate', same_native_identity: true, evidence_strength: 1,
        native_status: turn.status ?? 'unknown', native_turn_id: turn.id, error: 'native_turn_unresolved' };
    }
  } catch (error) {
    observation = { type: 'indeterminate', same_native_identity: false, evidence_strength: 1,
      error: error?.code ?? 'native_observation_failed' };
  } finally {
    clearTimeout(timer);
    lines.close();
    if (!closed) {
      const close = new Promise(resolve => {
        const grace = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, 2_000);
        child.once('close', () => { clearTimeout(grace); resolve(true); });
      });
      try { child.stdin.end(); } catch {}
      const closeConfirmed = await close;
      if (!closeConfirmed) {
        child.stdout?.destroy?.(); child.stderr?.destroy?.(); child.unref?.();
        observation = { type: 'indeterminate', same_native_identity: false, evidence_strength: 1,
          error: 'native_close_unconfirmed' };
      }
    }
  }
  return observation;
}
