import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const panel = require('../.build/package/src/cdp/dom-handlers/panel-capture.js');
const dialogs = require('../.build/package/src/cdp/dom-handlers/dialogs.js');

function driverFor(document, window = {}) {
  return {
    client: { send: async (method, params) => {
      assert.equal(method, 'Runtime.evaluate');
      return { result: { value: runInNewContext(params.expression, { document, window }) } };
    } },
  };
}

test('TRAE workbench folder path remains available when Explorer is hidden', async () => {
  const driver = driverFor(
    { title: 'workspace - TraeCode CN', querySelector: () => null },
    { icubeWorkspace: { folders: [{ uri: {
      scheme: 'file', fsPath: 'f:\\project\\workspace',
    } }] } },
  );
  const context = await panel.getWorkspaceContext(driver);
  assert.equal(context.rootPath, 'f:\\project\\workspace');
  assert.equal(context.hasExplorer, false);
});

test('TRAE result selector waits for the matching turn and returns only its final summary', async () => {
  let summaryText = null;
  const turn = {
    offsetParent: {},
    querySelectorAll: () => [{ textContent: 'Only answer: ready' }],
    querySelector: selector => selector.includes('user-message-query-text')
      ? { textContent: 'Only answer: ready' }
      : summaryText === null ? null : { innerText: summaryText },
  };
  const driver = driverFor({ querySelectorAll: () => [turn] });
  driver._pendingUserTask = 'Only answer: ready';
  let state = await panel._queryTaskSource(driver, '');
  assert.equal(state.awaitingAssistant, true);
  assert.equal(state.text, '');

  summaryText = 'ready';
  state = await panel._queryTaskSource(driver, '');
  assert.deepEqual(state, { text: 'ready', inProgress: false, isComplete: true, hasResponse: true });
});

test('multiline user binding includes empty lines and never scans a stale turn', async () => {
  let lines = ['中文 first', '', 'policy', 'second'];
  let summary = 'OWNED_REPLY';
  const turn = { offsetParent: {}, querySelectorAll: () => lines.map(textContent => ({ textContent })),
    querySelector: selector => selector.includes('user-message-query-text') ? { textContent: lines[0] } : summary ? { innerText: summary } : null };
  let visible = [turn];
  const driver = driverFor({ querySelectorAll: () => visible });
  driver._pendingUserTask = '中文 first\n\npolicy\nsecond';
  driver.detectMode = async () => { throw new Error('must not fall back to page text'); };
  assert.equal((await panel._queryTaskSource(driver, '')).text, 'OWNED_REPLY');
  summary = null;
  assert.equal((await panel._queryTaskSource(driver, '')).awaitingAssistant, true);
  summary = 'STALE_REPLY';
  const foreign = { offsetParent: {}, querySelectorAll: () => [{ textContent: 'different task' }], querySelector: () => null };
  visible = [turn, foreign];
  assert.equal((await panel._queryTaskSource(driver, '')).awaitingAssistant, true);
  visible = [];
  assert.equal((await panel._queryTaskSource(driver, '')).awaitingAssistant, true);
});

test('performance notifications do not hide genuine native approvals', async () => {
  function candidate(notification, captions, title) {
    const buttons = captions.map(textContent => ({ textContent, innerText: textContent, offsetParent: {} }));
    return { className: notification ? 'monaco-list-row' : 'monaco-dialog-box', textContent: title, offsetParent: {},
      getBoundingClientRect: () => ({ width: 200, height: 100 }),
      matches: () => notification, closest: () => notification ? {} : null, getAttribute: () => null,
      querySelector: () => null, querySelectorAll: () => buttons };
  }
  const notice = candidate(true, ['查看详情', '一键优化', '今日不再提醒'], 'TRAE 运行正常，系统资源压力较高');
  const trust = candidate(false, ['是，我信任此作者', '否，我不信任此作者'], '是否信任此文件夹中的文件的作者?');
  let elements = [notice];
  const document = { body: { innerText: '' }, querySelector: selector => selector === '[role="dialog"]' ? elements[0] : null,
    querySelectorAll: selector => selector === '[role="dialog"]' ? elements : [] };
  const driver = driverFor(document);
  assert.equal((await dialogs.checkForApprovalDialog(driver)).needsApproval, false);
  elements = [notice, trust];
  const modal = await dialogs.checkForApprovalDialog(driver);
  assert.equal(modal.needsApproval, true);
  assert.equal(modal.question, trust.textContent);
  elements = [candidate(true, ['允许', '拒绝'], '是否允许运行命令')];
  assert.equal((await dialogs.checkForApprovalDialog(driver)).needsApproval, true);
});
