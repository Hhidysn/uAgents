import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DoubaoTaskService } from '../src/service.mjs';
import { DoubaoDesktopBridge, readComposerText, readUserMessageText } from '../src/cdp.mjs';
import { TaskStore } from '../src/store.mjs';

const base=path.resolve('../../../../.local/test-runs');
function fixture(){fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'doubao-'));const store=new TaskStore(root);return {root,store,dispose:()=>fs.rmSync(root,{recursive:true,force:true})};}
class Bridge{
  constructor(){this.submits=0;this.observed=[];}
  async probe(){return {status:'available',submission:'not_sent'};}
  async prepareAndSubmit(prompt,publish){this.submits++;await publish({status:'running',submission:'may_have_been_sent'});this.prompt=prompt;return {target_id:'target-1',native_conversation_id:'12345',user_message_index:0};}
  async inspect(){const value=this.observed.shift();if(value instanceof Error)throw value;return value??{status:'running'};}
}

test('probe is connection-only',async()=>{const f=fixture();try{const bridge=new Bridge();const service=new DoubaoTaskService({store:f.store,bridge});assert.deepEqual(await service.probe(),{status:'available',submission:'not_sent'});assert.equal(bridge.submits,0);}finally{f.dispose();}});

test('submit records native identity and duplicate UUID never sends twice',async()=>{const f=fixture();try{const bridge=new Bridge(),service=new DoubaoTaskService({store:f.store,bridge});const input={request_id:randomUUID(),prompt:'bounded task',timeout_ms:20000};const first=await service.submit(input);assert.equal(first.status,'running');assert.equal(first.native_conversation_id,'12345');const duplicate=await service.submit(input);assert.equal(duplicate.duplicate,true);assert.equal(bridge.submits,1);const disk=fs.readFileSync(f.store.stateFile(input.request_id),'utf8');assert.equal(disk.includes('bounded task'),false);}finally{f.dispose();}});

test('same UUID with different prompt is rejected',async()=>{const f=fixture();try{const service=new DoubaoTaskService({store:f.store,bridge:new Bridge()}),id=randomUUID();await service.submit({request_id:id,prompt:'one'});await assert.rejects(()=>service.submit({request_id:id,prompt:'two'}),error=>error.code==='request_conflict');}finally{f.dispose();}});

test('window ownership prevents concurrent submissions',async()=>{const f=fixture();try{const held=f.store.acquire(randomUUID());const service=new DoubaoTaskService({store:f.store,bridge:new Bridge()});const result=await service.submit({request_id:randomUUID(),prompt:'second'});assert.equal(result.status,'failed');assert.equal(result.error,'window_busy');f.store.release(held);}finally{f.dispose();}});

test('status completes an owned task and releases the window',async()=>{const f=fixture();try{const bridge=new Bridge(),service=new DoubaoTaskService({store:f.store,bridge}),id=randomUUID();await service.submit({request_id:id,prompt:'answer'});bridge.observed.push({status:'running'},{status:'succeeded',response:'done',evidence:{stable_ms:300}});assert.equal((await service.status(id)).status,'running');const done=await service.result(id);assert.equal(done.status,'succeeded');assert.equal(done.result.response,'done');assert.equal(fs.existsSync(f.store.lockFile),false);}finally{f.dispose();}});

test('approval can be inspected again after the user acts',async()=>{const f=fixture();try{const bridge=new Bridge(),service=new DoubaoTaskService({store:f.store,bridge}),id=randomUUID();await service.submit({request_id:id,prompt:'ask'});bridge.observed.push({status:'needs_user',error:'native_approval_required'},{status:'succeeded',response:'approved'});assert.equal((await service.status(id)).status,'needs_user');assert.equal((await service.status(id)).status,'succeeded');}finally{f.dispose();}});

test('inspection failure becomes unknown and is not replayed',async()=>{const f=fixture();try{const bridge=new Bridge(),service=new DoubaoTaskService({store:f.store,bridge}),id=randomUUID();await service.submit({request_id:id,prompt:'ambiguous'});const error=Object.assign(new Error('lost'),{code:'cdp_unavailable'});bridge.observed.push(error);const result=await service.status(id);assert.equal(result.status,'unknown');assert.equal(result.error,'cdp_unavailable');assert.equal(bridge.submits,1);assert.equal((await service.submit({request_id:id,prompt:'ambiguous'})).duplicate,true);}finally{f.dispose();}});

class FakeCdpSocket{
  constructor(){this.listeners={};this.sent=[];this.repliers=[];queueMicrotask(()=>this.emit('open',{}));}
  addEventListener(type,handler){(this.listeners[type]??=[]).push(handler);}
  readyState=1;
  send(data){const message=JSON.parse(data);this.sent.push(message);queueMicrotask(()=>{const reply=this.repliers.reduce((acc,replier)=>acc??replier(message),null)??{id:message.id,result:{result:{value:null}}};this.emit('message',{data:JSON.stringify(reply)});});}
  emit(type,event){for(const handler of this.listeners[type]??[])handler(event);}
  close(){this.emit('close',{});}
}
class FakeCdpPage{
  constructor(){
    this.events=[];
    this.url='doubaowork://doubaowork-chat/chat';
    this.socket=new FakeCdpSocket();
    this.evaluateResponses=new Map([['blocked',false]]);
    this.socket.repliers.push(message=>{
      if(message.method==='Input.insertText')this.record('insert',{});
      if(message.method==='Input.dispatchKeyEvent'&&message.params?.type==='rawKeyDown'){this.record('enter',{});this.url='doubaowork://doubaowork-chat/chat/12345';}
      if(message.method==='Runtime.evaluate'){
        const key=this.matchEvaluate(String(message.params?.expression??''));
        const value=this.evaluateResponses.get(key);
        if(value!==undefined){this.record(key,{});return {id:message.id,result:{result:{value}}};}
      }
      return null;
    });
  }
  matchEvaluate(expression){
    if(expression.includes('composerBlockedByModal'))return 'blocked';
    if(expression.includes('createRange'))return 'focus';
    if(expression.includes('readComposerText'))return 'confirm';
    if(expression.includes('userText'))return 'submitted';
    if(expression.includes('readyState'))return 'state';
    return 'unknown';
  }
  emitEvaluate(key,value){this.evaluateResponses.set(key,value);}
  record(kind,detail){this.events.push({kind,...detail});}
}

function cdpFixture(page,{port=9222}={}){
  const fetchImpl=async url=>{
    if(String(url).endsWith('/json/version'))return {ok:true,json:async()=>({Browser:'Doubao/1','Protocol-Version':'1.3'})};
    if(String(url).endsWith('/json/list'))return {ok:true,json:async()=>[{id:'page-1',type:'page',url:page.url,webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/page/page-1`}]};
    return {ok:true,json:async()=>({})};
  };
  return {fetchImpl};
}

function newBridge(page){
  const {fetchImpl}=cdpFixture(page);
  return new DoubaoDesktopBridge({fetchImpl,websocketFactory:()=>{page.socket.connectAttempts=(page.socket.connectAttempts??0)+1;queueMicrotask(()=>page.socket.emit('open',{}));return page.socket;}});
}

test('bridge publishes may_have_been_sent before the first prompt-bearing DOM mutation',async()=>{
  const page=new FakeCdpPage();
  page.emitEvaluate('state',{ready:'complete',messages:0,inputs:1,guidance:true});
  page.emitEvaluate('focus',true);
  page.emitEvaluate('confirm',true);
  page.emitEvaluate('submitted',{messages:1,userText:'bounded prompt',inputLength:0});
  const publishCalls=[];
  const publish=async patch=>{publishCalls.push(patch);page.record('publish',{});};
  const bridge=newBridge(page);
  const native=await bridge.prepareAndSubmit('bounded prompt',publish);
  assert.equal(native.native_conversation_id,'12345');
  const order=page.events.map(event=>event.kind);
  const firstInsert=order.indexOf('insert');
  const firstPublish=order.indexOf('publish');
  assert.ok(firstPublish>=0,'publish must be recorded');
  assert.ok(firstInsert>=0,'prompt-bearing DOM mutation must be recorded');
  assert.ok(firstPublish<firstInsert,'publish(may_have_been_sent) must precede prompt insertion');
  assert.equal(publishCalls[0]?.submission,'may_have_been_sent');
  const enterCalls=page.socket.sent.filter(message=>message.method==='Input.dispatchKeyEvent');
  assert.equal(enterCalls.length,2,'Enter is dispatched only after the checkpoint publish');
});

test('bridge skips prompt insertion and Enter when the checkpoint publish rejects',async()=>{
  const page=new FakeCdpPage();
  page.emitEvaluate('state',{ready:'complete',messages:0,inputs:1,guidance:true});
  page.emitEvaluate('focus',true);
  page.emitEvaluate('confirm',true);
  let publishCalls=0;
  const publish=async patch=>{publishCalls++;throw new Error('checkpoint rejected');};
  const bridge=newBridge(page);
  await assert.rejects(()=>bridge.prepareAndSubmit('bounded prompt',publish),{message:'checkpoint rejected'});
  assert.equal(publishCalls,1);
  const kinds=page.events.map(event=>event.kind);
  assert.equal(kinds.includes('insert'),false,'prompt-bearing DOM mutation must not run after checkpoint failure');
  const enterCalls=page.socket.sent.filter(message=>message.method==='Input.dispatchKeyEvent');
  assert.equal(enterCalls.length,0,'Enter must not be dispatched after checkpoint failure');
});

test('bridge discovers a logged-in blank chat with a trailing slash',async()=>{
  const page=new FakeCdpPage();page.url+='/' ;
  const found=await newBridge(page).probe();
  assert.equal(found.page_state,'blank');
  assert.equal(found.target_id,'page-1');
});

test('composer text preserves paragraph boundaries and hard breaks without caret sentinels',()=>{
  const text=value=>({nodeType:3,nodeValue:value});
  const element=(name,children=[],sentinel=false)=>({nodeType:1,nodeName:name,childNodes:children,classList:{contains:()=>sentinel}});
  const composer={childNodes:[element('P',[text(' leading 中文 ')]),element('P',[element('BR',[],true)]),element('P',[text('x'),element('BR'),text('y ')]),element('P',[element('BR',[],true)])]};
  assert.equal(readComposerText(composer),' leading 中文 \n\nx\ny \n');
});

test('user messages restore native markdown paragraph spacing without collapsing text',()=>{
  const root={classList:{contains:()=>true},childNodes:[{nodeType:1,nodeName:'DIV',textContent:'中文 first '},{nodeType:1,nodeName:'SPAN',childNodes:[]},{nodeType:1,nodeName:'DIV',textContent:'policy\nsecond'}]};
  assert.equal(readUserMessageText(root),'中文 first \n\npolicy\nsecond');
});

test('a native modal waits for the user before any prompt-bearing mutation',async()=>{
  const page=new FakeCdpPage();page.emitEvaluate('blocked',true);
  page.emitEvaluate('state',{ready:'complete',messages:0,inputs:1,guidance:true});
  const bridge=newBridge(page);
  assert.equal((await bridge.probe()).status,'waiting_user');
  let published=false;
  await assert.rejects(()=>bridge.prepareAndSubmit('bounded',async()=>{published=true;}),{code:'native_dialog_required'});
  assert.equal(published,false);
  assert.equal(page.socket.sent.some(message=>message.method==='Input.insertText'||message.method==='Input.dispatchKeyEvent'),false);
});

test('bridge sends exact multiline text through native input after focus',async()=>{
  const page=new FakeCdpPage();const prompt='中文\nsecond line';
  page.emitEvaluate('state',{ready:'complete',messages:0,inputs:1,guidance:true});
  page.emitEvaluate('focus',true);page.emitEvaluate('confirm',true);
  page.emitEvaluate('submitted',{messages:1,userText:prompt,inputLength:0});
  await newBridge(page).prepareAndSubmit(prompt,async()=>{});
  const inserts=page.socket.sent.filter(message=>message.method==='Input.insertText');
  assert.equal(inserts.length,1);assert.equal(inserts[0].params.text,prompt);
  const expressions=page.socket.sent.filter(message=>message.method==='Runtime.evaluate').map(message=>message.params.expression);
  assert.equal(expressions.some(expression=>expression.includes('execCommand')),false);
  assert.ok(page.events.findIndex(event=>event.kind==='focus')<page.events.findIndex(event=>event.kind==='insert'));
});

test('bridge never presses Enter when the native input cannot be confirmed',async()=>{
  const page=new FakeCdpPage();
  page.emitEvaluate('state',{ready:'complete',messages:0,inputs:1,guidance:true});
  page.emitEvaluate('focus',true);page.emitEvaluate('confirm',false);
  await assert.rejects(()=>newBridge(page).prepareAndSubmit('bounded',async()=>{}),{code:'prompt_insertion_unconfirmed'});
  assert.equal(page.socket.sent.filter(message=>message.method==='Input.insertText').length,1);
  assert.equal(page.socket.sent.some(message=>message.method==='Input.dispatchKeyEvent'),false);
});
