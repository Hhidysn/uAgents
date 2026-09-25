import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const panel = require('../.build/package/src/cdp/dom-handlers/panel-capture.js');

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
