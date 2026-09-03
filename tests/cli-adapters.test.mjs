import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createParser,invokeCli,locateCli} from '../plugins/uagents/skills/agent-dispatch/scripts/cli-adapters.mjs';
import {atomicJson,digest,normalizeRequest,status,terminalStates} from '../plugins/uagents/skills/agent-dispatch/scripts/store.mjs';
import {submit,result,cancel} from '../plugins/uagents/skills/agent-dispatch/scripts/task.mjs';
const root=path.resolve('.local/test-runs',randomUUID(),'CLI 空格');fs.mkdirSync(root,{recursive:true});
const worker=fileURLToPath(new URL('./fixtures/cli-test-worker.mjs',import.meta.url));
const request=(target,patch={})=>({request_id:randomUUID(),target,model:target==='workbuddy'?'workbuddy-default':'commandcode-goat/deepseek/deepseek-v4-flash',mode:'analysis',prompt:'success',timeout_ms:5000,...patch});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(id,predicate=s=>terminalStates.has(s.status)){
 const end=Date.now()+8000;while(Date.now()<end){const state=status(root,id);if(predicate(state))return state;await delay(40);}assert.fail('Task did not finish');
}
function wbParser(){const r=request('workbuddy'),p=createParser(r,root,()=>{});p.event({type:'system',subtype:'init',session_id:r.request_id,cwd:root,model:'native-default'});return {p,r};}
const wbResult=(id,patch={})=>({type:'result',session_id:id,subtype:'success',is_error:false,result:'answer',...patch});
const ocEvent=(type,id,message='final',extra={})=>({type,sessionID:'ses_test',part:{id,messageID:message,sessionID:'ses_test',...extra}});

test('routes are explicit and limited; unrelated targets and paid fallbacks are rejected',()=>{
 assert.throws(()=>normalizeRequest(request('workbuddy',{model:'unknown-paid'})),{code:'invalid_model'});
 assert.throws(()=>normalizeRequest(request('opencode',{model:'opencode-go/deepseek-v4-pro'})),{code:'invalid_model'});
 assert.throws(()=>normalizeRequest(request('opencode',{model:'opencode-go/deepseek-v4-flash'})),{code:'invalid_model'});
 assert.throws(()=>normalizeRequest(request('opencode',{model:'opencode-go/glm-5.2'})),{code:'invalid_model'});
 assert.throws(()=>normalizeRequest(request('opencode',{mode:'implementation'})),{code:'unsupported_capability'});
 assert.throws(()=>normalizeRequest(request('workbuddy',{fallback_model:'other'})),{code:'unsupported_field'});
});
test('Windows discovery finds native npm executable without invoking a command shell',{skip:process.platform!=='win32'},()=>{
 const bin=path.join(root,'npm path/node_modules/opencode-ai/bin/opencode.exe');fs.mkdirSync(path.dirname(bin),{recursive:true});fs.writeFileSync(bin,'fixture only');
 assert.equal(locateCli('opencode',{PATH:path.join(root,'npm path')}),bin);
 assert.throws(()=>locateCli('opencode',{UAGENTS_OPENCODE_BIN:'relative.cmd'}),{code:'invalid_cli_path'});
});
test('WorkBuddy validates session and cwd, handles duplicate result and native errors',()=>{
 const {p,r}=wbParser();assert.throws(()=>p.event(wbResult(randomUUID())),{code:'native_session_mismatch'});
 p.event(wbResult(r.request_id,{is_error:true,subtype:'error_max_turns'}));assert.equal(p.finish(0).status,'failed');
 assert.throws(()=>p.event(wbResult(r.request_id)),{code:'duplicate_result'});
 const q=createParser(r,root,()=>{});assert.throws(()=>q.event({type:'system',subtype:'init',session_id:r.request_id,cwd:path.dirname(root)}),{code:'native_session_mismatch'});
});
test('WorkBuddy approval denial overrides success and active background work prevents completion',()=>{
 const {p,r}=wbParser();p.event(wbResult(r.request_id,{permission_denials:[{tool_name:'Write'}]}));assert.equal(p.finish(0).status,'needs_user');
 const {p:q,r:s}=wbParser();q.event({type:'system',subtype:'task_started',session_id:s.request_id,task_id:'bg'});q.event(wbResult(s.request_id));assert.equal(q.finish(0).status,'unknown');
 q.event({type:'system',subtype:'task_updated',session_id:s.request_id,task_id:'bg',patch:{status:'completed'}});assert.equal(q.finish(0).status,'succeeded');
 q.event({type:'system',subtype:'task_notification',session_id:s.request_id,task_id:'bg-failed',status:'failed'});assert.equal(q.finish(0).status,'failed');
});
test('OpenCode returns only final message text and deduplicates completed part updates',()=>{
 const p=createParser(request('opencode'),root,()=>{});
 p.event(ocEvent('step_start','old-start','previous'));
 p.event(ocEvent('text','old','previous',{text:'progress, not the answer'}));p.event(ocEvent('step_finish','old-end','previous',{reason:'tool-calls'}));
 assert.equal(p.finish(0).status,'unknown');p.event(ocEvent('step_start','start'));
 p.event(ocEvent('text','text','final',{text:'partial'}));p.event(ocEvent('text','text','final',{text:'complete'}));p.event(ocEvent('step_finish','end','final',{reason:'stop'}));
 assert.equal(p.finish(0).result.response,'complete');assert.equal(p.finish(0).status,'succeeded');assert.equal(p.finish(1).status,'unknown');
 p.event({type:'error',sessionID:'ses_test',error:{name:'APIError'}});assert.equal(p.finish(0).status,'failed');
});
test('OpenCode cannot reuse planning text when another step shares the message ID',()=>{
 const p=createParser(request('opencode'),root,()=>{});
 p.event(ocEvent('step_start','start-1'));p.event(ocEvent('text','planning','final',{text:'old planning'}));
 p.event(ocEvent('step_finish','end-1','final',{reason:'tool-calls'}));p.event(ocEvent('step_start','start-2'));
 p.event(ocEvent('step_finish','end-2','final',{reason:'stop'}));
 assert.equal(p.finish(0).status,'unknown');assert.equal(p.finish(0).result.response,'');
});
test('pre-recorded cancellation does not require any installed CLI',async()=>{
 const directory=path.join(root,randomUUID());fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'cancel.json'),'{}');
 const driver={get command(){throw new Error('must not resolve driver');}};
 assert.equal((await invokeCli(directory,directory,request('workbuddy'),()=>{},driver)).status,'cancelled');
});
test('process error after deadline does not overwrite its original outcome',async()=>{
 const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),unref(){},kill(){this.emit('error',new Error('kill error'));setImmediate(()=>this.emit('close',null));}});
 const driver={command:'fixture',args:[],spawn(){setImmediate(()=>child.emit('spawn'));return child;}};
 const done=await invokeCli(root,root,request('opencode',{timeout_ms:1000}),()=>{},driver);
 assert.equal(done.status,'unknown');assert.equal(done.error,'deadline_remote_state_unknown');
});
test('stale committed registration without worker acknowledgement is explicit and never replayed',async()=>{
 const input=request('workbuddy'),directory=path.join(root,input.request_id);fs.mkdirSync(directory);
 atomicJson(path.join(directory,'state.json'),{task_id:input.request_id,status:'starting',registration_complete:true,digest:digest(normalizeRequest(input)),updated_at_ms:Date.now()-20000,submission:'not_sent'});
 atomicJson(path.join(directory,'inbox.json'),normalizeRequest(input));
 assert.equal(status(root,input.request_id).error,'worker_launch_unconfirmed');
 await assert.rejects(submit(root,input,{worker}),{code:'worker_launch_unconfirmed'});
 assert.equal(fs.existsSync(path.join(directory,'workspace')),false);
});
test('OpenCode rejects mixed sessions and unconfirmed completion; permissions are not success',()=>{
 const p=createParser(request('opencode'),root,()=>{});p.event(ocEvent('step_start','start'));
 assert.throws(()=>p.event({...ocEvent('text','text','final',{text:'other'}),sessionID:'ses_other'}),{code:'native_session_mismatch'});
 assert.equal(p.finish(0).status,'unknown');p.stderr('permission requested: edit; auto-rejecting');assert.equal(p.finish(0).status,'needs_user');
});
for(const target of ['workbuddy','opencode']){
 test(`${target}: native stream, detached completion and concurrent dedup`,async()=>{
  const input=request(target,target==='workbuddy'?{mode:'implementation',expected_outputs:['artifact.txt']}:{});
  const outputs=await Promise.all([submit(root,input,{worker}),submit(root,input,{worker})]);assert.equal(outputs[1].duplicate,true);
  const done=await wait(input.request_id);assert.equal(done.status,'succeeded');
  assert.equal(result(root,input.request_id).result.response,'中文结果 ✓');
  assert.equal(fs.readFileSync(path.join(root,input.request_id,'workspace/received.txt'),'utf8'),'submitted\n');
  if(target==='workbuddy')assert.equal(done.artifact_check,'passed');
 });
 test(`${target}: version probe is not a model readiness claim`,async()=>{
  const input=request(target);delete input.prompt;await submit(root,input,{worker,kind:'probe'});
  const done=await wait(input.request_id);assert.equal(done.scope,'version_only');assert.equal(done.submission,'not_sent');
 });
 test(`${target}: malformed stream stays unknown and is not replayed`,async()=>{
  const input=request(target,{prompt:'malformed'});await submit(root,input,{worker});assert.equal((await wait(input.request_id)).status,'unknown');
  assert.equal((await submit(root,input,{worker})).duplicate,true);
 });
 test(`${target}: clean exit without completion stays unknown`,async()=>{
  const input=request(target,{prompt:'truncated'});await submit(root,input,{worker});
  const done=await wait(input.request_id);assert.equal(done.native_exit_code,0);assert.equal(done.status,'unknown');
  assert.equal(done.error,'native_completion_unconfirmed');assert.ok(done.native_session_id);
 });
 test(`${target}: deadline after submission preserves identity and prevents replay`,async()=>{
  const input=request(target,{prompt:'hang',timeout_ms:1000});await submit(root,input,{worker});
  const done=await wait(input.request_id);assert.equal(done.status,'unknown');assert.equal(done.error,'deadline_remote_state_unknown');assert.ok(done.native_session_id);
  assert.equal((await submit(root,input,{worker})).duplicate,true);
 });
 test(`${target}: cancellation retains native identity without claiming remote cancellation`,async()=>{
  const input=request(target,{prompt:'hang'});await submit(root,input,{worker});await wait(input.request_id,s=>Boolean(s.native_session_id));
  cancel(root,input.request_id);const done=await wait(input.request_id);assert.equal(done.status,'unknown');assert.equal(done.error,'cancel_remote_state_unknown');
 });
}
