import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DoubaoTaskService } from '../src/service.mjs';
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
