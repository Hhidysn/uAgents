const CHAT_BASE = 'doubaowork://doubaowork-chat/chat';
const CHAT_URL = /^doubaowork:\/\/doubaowork-chat\/chat(?:\/(\d+))?$/;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

export class CdpConnection {
  constructor(socket, timeoutMs = 5000) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      message.error ? pending.reject(Object.assign(new Error(message.error.message), { code: 'cdp_error' })) : pending.resolve(message.result);
    });
    socket.addEventListener('close', () => this.failPending('cdp_closed'));
    socket.addEventListener('error', () => this.failPending('cdp_socket_error'));
  }

  failPending(code) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Object.assign(new Error(code), { code })); }
    this.pending.clear();
  }

  call(method, params = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(Object.assign(new Error('CDP is not open.'), { code: 'cdp_closed' }));
    const id = ++this.sequence;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('CDP request timed out.'), { code: 'cdp_timeout' })); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Object.assign(new Error('Page evaluation failed.'), { code: 'page_evaluation_failed' });
    return result.result.value;
  }

  close() { this.socket.close(); }
}

export class DoubaoDesktopBridge {
  constructor({ port = Number(process.env.UAGENTS_DOUBAO_CDP_PORT ?? 9222), fetchImpl = fetch, websocketFactory = url => new WebSocket(url) } = {}) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Object.assign(new Error('Invalid CDP port.'), { code: 'invalid_cdp_port' });
    this.port = port;
    this.origin = `http://127.0.0.1:${port}`;
    this.fetchImpl = fetchImpl;
    this.websocketFactory = websocketFactory;
  }

  async json(path) {
    let response;
    try { response = await this.fetchImpl(`${this.origin}${path}`, { signal: AbortSignal.timeout(3000) }); }
    catch { throw Object.assign(new Error('Doubao Work CDP is unavailable. Start the app with a loopback remote-debugging port.'), { code: 'cdp_unavailable' }); }
    if (!response.ok) throw Object.assign(new Error(`CDP HTTP ${response.status}.`), { code: 'cdp_unavailable' });
    return response.json();
  }

  async discover() {
    const [version, targets] = await Promise.all([this.json('/json/version'), this.json('/json/list')]);
    const chats = targets.filter(item => item.type === 'page' && CHAT_URL.test(item.url));
    if (chats.length !== 1) throw Object.assign(new Error(`Expected one Doubao Work chat target; found ${chats.length}.`), { code: 'chat_target_ambiguous' });
    return { version: version.Browser ?? null, protocol: version['Protocol-Version'] ?? null, page: chats[0] };
  }

  async connect(page) {
    const socket = this.websocketFactory(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('CDP connection timed out.'), { code: 'cdp_timeout' })), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(Object.assign(new Error('CDP connection failed.'), { code: 'cdp_socket_error' })); }, { once: true });
    });
    return new CdpConnection(socket);
  }

  async probe() {
    const found = await this.discover();
    const match = found.page.url.match(CHAT_URL);
    return { status: 'available', scope: 'connection_only', browser: found.version, protocol: found.protocol, target_id: found.page.id,
      page_state: match?.[1] ? 'conversation' : 'blank', native_conversation_id: match?.[1] ?? null, submission: 'not_sent' };
  }

  async prepareAndSubmit(prompt, publish) {
    const found = await this.discover();
    const connection = await this.connect(found.page);
    try {
      if (found.page.url !== CHAT_BASE) await connection.call('Page.navigate', { url: CHAT_BASE });
      let state;
      for (let attempt = 0; attempt < 40; attempt++) {
        await delay(250);
        state = await connection.evaluate(`(()=>({ready:document.readyState,messages:document.querySelectorAll('[data-testid="message_text_content"]').length,inputs:document.querySelectorAll('[contenteditable="true"]').length,guidance:!!document.querySelector('[data-testid="flow_chat_guidance_page"]')}))()`);
        if (state.ready === 'complete' && state.messages === 0 && state.inputs === 1 && state.guidance) break;
      }
      if (!state || state.messages !== 0 || state.inputs !== 1 || !state.guidance) throw Object.assign(new Error('Could not establish a blank Doubao Work task page.'), { code: 'blank_task_unconfirmed' });
      const value = JSON.stringify(prompt);
      const inserted = await connection.evaluate(`(()=>{const e=document.querySelector('[contenteditable="true"]');if(!e)return false;e.focus();document.execCommand('selectAll');document.execCommand('insertText',false,${value});e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:null}));return e.innerText===${value}})()`);
      if (!inserted) throw Object.assign(new Error('Prompt insertion could not be confirmed.'), { code: 'prompt_insertion_unconfirmed' });
      await publish({ status: 'running', submission: 'may_have_been_sent', target_id: found.page.id });
      await connection.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await connection.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      let submitted;
      for (let attempt = 0; attempt < 40; attempt++) {
        await delay(250);
        const targets = await this.json('/json/list');
        const page = targets.find(item => item.id === found.page.id);
        const conversation = page?.url?.match(CHAT_URL)?.[1];
        if (!conversation) continue;
        submitted = await connection.evaluate(`(()=>{const nodes=[...document.querySelectorAll('[data-testid="message_text_content"]')];const input=document.querySelector('[contenteditable="true"]');return {messages:nodes.length,userText:(nodes[0]?.innerText||nodes[0]?.textContent||'').trim(),inputLength:(input?.innerText||'').trim().length}})()`);
        if (submitted.messages >= 1 && submitted.userText === prompt && submitted.inputLength === 0) return { target_id: found.page.id, native_conversation_id: conversation, user_message_index: 0 };
      }
      throw Object.assign(new Error('Prompt may have been sent, but native conversation identity is unconfirmed.'), { code: 'submission_identity_unconfirmed' });
    } finally { connection.close(); }
  }

  async inspect(targetId, conversationId, userMessageIndex = 0) {
    const targets = await this.json('/json/list');
    const expected = `${CHAT_BASE}/${conversationId}`;
    const page = targets.find(item => item.id === targetId && item.type === 'page');
    if (!page || page.url !== expected) return { status: 'unknown', error: 'controlled_conversation_missing' };
    const connection = await this.connect(page);
    try {
      const expression = `(()=>{const nodes=[...document.querySelectorAll('[data-testid="message_text_content"]')];const replies=nodes.slice(${userMessageIndex + 1}).map(n=>(n.innerText||n.textContent||'').trim()).filter(Boolean);const active=[...document.querySelectorAll('[data-testid],[aria-label],button')].some(n=>{const s=(n.getAttribute('data-testid')||'')+' '+(n.getAttribute('aria-label')||'')+' '+String(n.className||'');return /stop[_-]?generation|\\bgenerating\\b|停止生成|终止生成/i.test(s)&&!/regenerate/i.test(s)});const finished=!!document.querySelector('[data-testid="message_action_regenerate"]');const approval=[...document.querySelectorAll('[role="dialog"] button')].some(b=>/允许|拒绝|确认|授权|继续/.test((b.innerText||'').trim()));return {replies,active,finished,approval,total:nodes.length}})()`;
      const first = await connection.evaluate(expression);
      if (first.approval) return { status: 'needs_user', error: 'native_approval_required' };
      if (!first.replies.length || first.active || !first.finished) return { status: 'running', response: first.replies.at(-1) ?? '' };
      await delay(300);
      const second = await connection.evaluate(expression);
      const firstResponse=first.replies.join('\n'),response=second.replies.join('\n');
      if(Buffer.byteLength(response)>1048576)return {status:'unknown',error:'result_too_large'};
      if (!second.active && second.finished && response && response === firstResponse) return { status: 'succeeded', response, evidence: { message_count: second.total, new_reply_count: second.replies.length, completion_control: 'message_action_regenerate', stable_ms: 300 } };
      return { status: 'running', response };
    } finally { connection.close(); }
  }
}
