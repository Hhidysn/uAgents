// Local stdio JSON-RPC fixture. Does not import Codex or contact a provider.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

if (process.argv.slice(2).join(' ') === '--version') {
  process.stdout.write('codex-cli fixture/1\n');
  process.exit(0);
}
if (process.argv.slice(2).join(' ') !== 'app-server --stdio') process.exit(2);
const journalPath = path.join(process.cwd(), '.codex-app-server-fixture.json');
const journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  : { calls: [], threads: {} };
const save = () => {
  const temporary = `${journalPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(journal));
  fs.renameSync(temporary, journalPath);
};
const write = frame => process.stdout.write(`${JSON.stringify(frame)}\n`);
let initialized = false;
let threadId = null;
let interruptTurnId = null;
let interruptMode = null;
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  journal.calls.push(frame);
  save();
  if (frame.method === 'initialize' && frame.params?.clientInfo?.name === 'uagents') {
    write({ id: frame.id, result: { userAgent: 'fixture/1', platformFamily: 'windows', platformOs: 'windows' } });
  } else if (frame.method === 'initialized') {
    initialized = true;
  } else if (frame.method === 'thread/start' && initialized) {
    threadId = randomUUID();
    journal.threads[threadId] = [];
    save();
    write({ id: frame.id, result: { thread: { id: threadId } } });
  } else if (['thread/read', 'thread/turns/list', 'thread/items/list'].includes(frame.method) &&
      journal.unreadableThreads?.includes(frame.params?.threadId)) {
    write({ id: frame.id, error: { code: -32603, message: 'fixture empty rollout' } });
  } else if (frame.method === 'thread/read' && initialized && journal.threads[frame.params?.threadId]) {
    write({ id: frame.id, result: { thread: { id: frame.params.threadId,
      turns: frame.params.includeTurns ? journal.threads[frame.params.threadId] : [] } } });
  } else if (frame.method === 'thread/turns/list' && initialized && journal.threads[frame.params?.threadId]) {
    const all = frame.params.sortDirection === 'asc'
      ? journal.threads[frame.params.threadId]
      : [...journal.threads[frame.params.threadId]].reverse();
    const offset = Number(frame.params.cursor ?? 0);
    const limit = Math.min(frame.params.limit ?? 64, journal.fixtureHistoryPageSize ?? Infinity);
    const page = all.slice(offset, offset + limit);
    write({ id: frame.id, result: { data: page.map(turn => ({ id: turn.id, status: turn.status,
      itemsView: frame.params.itemsView === 'full' && !journal.fixtureFullItemsIncomplete ? 'full' : 'notLoaded',
      items: frame.params.itemsView === 'full' && !journal.fixtureFullItemsIncomplete ? turn.items : [] })),
      nextCursor: journal.fixtureHistoryCursorLoop ? '0'
        : offset + limit < all.length ? String(offset + limit) : null } });
  } else if (frame.method === 'thread/items/list' && initialized && journal.threads[frame.params?.threadId]) {
    if (journal.fixtureItemsListUnsupported) {
      write({ id: frame.id, error: { code: -32601, message: 'Method not found' } });
      continue;
    }
    const turn = journal.threads[frame.params.threadId].find(item => item.id === frame.params.turnId);
    const items = turn?.items ?? [];
    const offset = Number(frame.params.cursor ?? 0);
    const limit = frame.params.limit ?? 64;
    write({ id: frame.id, result: { data: items.slice(offset, offset + limit).map(item => ({ turnId: turn.id, item })),
      nextCursor: offset + limit < items.length ? String(offset + limit) : null } });
  } else if (frame.method === 'thread/resume' && initialized && journal.threads[frame.params?.threadId]) {
    threadId = frame.params.threadId;
    if (journal.fixtureAdvanceOnResume) {
      journal.threads[threadId].push({ id: randomUUID(), status: 'completed', items: [] });
      journal.fixtureAdvanceOnResume = false;
      save();
    }
    write({ id: frame.id, result: { thread: { id: threadId } } });
  } else if (frame.method === 'thread/fork' && initialized && journal.threads[frame.params?.threadId]) {
    const source = frame.params.threadId;
    const through = journal.threads[source].findIndex(turn => turn.id === frame.params.lastTurnId);
    if (through < 0) {
      write({ id: frame.id, error: { code: -32602, message: 'Unknown source turn' } });
      continue;
    }
    threadId = randomUUID();
    journal.threads[threadId] = journal.threads[source].slice(0, through + 1);
    save();
    write({ id: frame.id, result: { thread: { id: threadId, forkedFromId: source } } });
  } else if (frame.method === 'turn/start' && frame.params?.threadId === threadId) {
    const prompt = frame.params.input?.[0]?.text ?? '';
    const turnId = randomUUID();
    if (prompt.includes('fixture-no-turn-ack-saved')) {
      journal.threads[threadId].push({ id: turnId, status: 'completed', items: [
        { id: randomUUID(), type: 'userMessage', clientId: frame.params.clientUserMessageId },
        { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'fixture app-server answer' },
      ] });
      save();
      process.exit(0); // The native Turn completed, but the client saw no turn/start reply.
    }
    if (prompt.includes('fixture-crash-after-send-saved')) {
      journal.threads[threadId].push({ id: turnId, status: 'completed', items: [
        { id: randomUUID(), type: 'userMessage', clientId: frame.params.clientUserMessageId },
        { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'fixture crash after send answer' },
      ] });
      save();
      continue; // Keep the Worker waiting for a reply until the test kills it.
    }
    if (prompt.includes('fixture-approval-command') || prompt.includes('fixture-approval-file')) {
      journal.threads[threadId].push({ id: turnId, status: 'inProgress', items: [] });
      save();
      const fileChange = prompt.includes('fixture-approval-file');
      const approvalRequest = { id: 99, method: fileChange
        ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval',
      params: { threadId,
        turnId, itemId: randomUUID(), startedAtMs: Date.now(),
        ...(fileChange ? { reason: 'fixture file change' }
          : { command: 'echo fixture', cwd: process.cwd() }) } };
      if (prompt.includes('fixture-approval-command-early')) write(approvalRequest);
      write({ id: frame.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      if (!prompt.includes('fixture-approval-command-early')) write(approvalRequest);
      continue;
    }
    if (prompt.includes('fixture-approval')) {
      write({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId, turnId } });
      continue;
    }
    const turnReply = { id: frame.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } };
    if (prompt.includes('fixture-empty-rollout-after-accepted')) {
      journal.unreadableThreads ??= [];
      journal.unreadableThreads.push(threadId);
      save();
      write(turnReply);
      process.exit(0); // The accepted Turn has no readable native rollout.
    }
    if (prompt.includes('fixture-crash-after-accepted-saved')) {
      journal.threads[threadId].push({ id: turnId, status: 'completed', items: [
        { id: randomUUID(), type: 'userMessage', clientId: frame.params.clientUserMessageId },
        { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'fixture crash recovery answer' },
      ] });
      save();
      write(turnReply);
      continue;
    }
    if (prompt.includes('fixture-interrupt')) {
      interruptTurnId = turnId;
      interruptMode = prompt.includes('fixture-interrupt-no-terminal') ? 'no-terminal'
        : prompt.includes('fixture-interrupt-lost-ack') ? 'lost-ack'
          : prompt.includes('fixture-interrupt-missing-terminal-saved') ? 'missing-terminal-saved'
          : prompt.includes('fixture-interrupt-rpc-error') ? 'rpc-error'
          : prompt.includes('fixture-interrupt-completes') ? 'completed' : 'terminal';
      journal.threads[threadId].push({ id: turnId, status: 'inProgress', items: [] });
      save();
      if (!prompt.includes('fixture-interrupt-before-turn-ack')) write(turnReply);
      continue;
    }
    if (!prompt.includes('fixture-early-events')) write(turnReply);
    if (prompt.includes('fixture-missing-terminal-saved')) {
      journal.threads[threadId].push({ id: turnId, status: 'completed', items: [
        { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'fixture app-server answer' },
      ] });
      save();
      process.exit(0); // Simulate a lost completion notification after a native completed Turn.
    }
    if (prompt.includes('fixture-missing-terminal')) { process.exit(0); }
    const reportedThread = prompt.includes('fixture-wrong-thread') ? randomUUID() : threadId;
    write({ method: 'item/completed', params: { threadId: reportedThread, turnId,
      completedAtMs: Date.now(), item: { id: randomUUID(), type: 'agentMessage', text: 'fixture app-server answer' } } });
    write({ method: 'turn/completed', params: { threadId: reportedThread,
      turn: { id: turnId, status: 'completed', items: [] } } });
    journal.threads[threadId].push({ id: turnId, status: 'completed', items: [] });
    save();
    if (prompt.includes('fixture-early-events')) write(turnReply);
  } else if (frame.method === 'turn/interrupt' && frame.params?.threadId === threadId &&
      frame.params?.turnId === interruptTurnId) {
    if (interruptMode === 'rpc-error') {
      write({ id: frame.id, error: { code: -32603, message: 'Fixture interrupt failed' } });
      continue;
    }
    if (interruptMode === 'missing-terminal-saved') {
      const turn = journal.threads[threadId].find(item => item.id === interruptTurnId);
      turn.status = 'interrupted';
      save();
      process.exit(0); // Native terminal is durable, but no notification reaches uAgents.
    }
    if (interruptMode !== 'lost-ack') write({ id: frame.id, result: {} });
    if (interruptMode !== 'no-terminal') {
      const turn = journal.threads[threadId].find(item => item.id === interruptTurnId);
      turn.status = interruptMode === 'completed' ? 'completed' : 'interrupted';
      if (interruptMode === 'completed') {
        turn.items = [{ id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'fixture completed before interrupt' }];
      }
      save();
      if (interruptMode === 'completed') write({ method: 'item/completed', params: { threadId, turnId: interruptTurnId,
        item: { id: randomUUID(), type: 'agentMessage', text: 'fixture completed before interrupt' } } });
      write({ method: 'turn/completed', params: { threadId,
        turn: { id: interruptTurnId, status: turn.status, items: turn.items } } });
    }
  } else {
    write({ id: frame.id ?? 0, error: { code: -32600, message: 'Invalid fixture request' } });
  }
}
