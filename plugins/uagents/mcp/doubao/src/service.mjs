import { DoubaoDesktopBridge } from './cdp.mjs';
import { TaskStore, fail, hash, terminal } from './store.mjs';

function normalize(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))fail('invalid_request','Expected an object.');
  for(const key of Object.keys(input))if(!['request_id','prompt','timeout_ms'].includes(key))fail('unsupported_field',`Unsupported field: ${key}`);
  if(typeof input.prompt!=='string'||!input.prompt.trim()||Buffer.byteLength(input.prompt)>65536)fail('invalid_prompt','prompt must contain 1–65536 UTF-8 bytes.');
  const timeout=input.timeout_ms??300000;
  if(!Number.isInteger(timeout)||timeout<10000||timeout>1200000)fail('invalid_timeout','timeout_ms must be 10000–1200000.');
  return {request_id:input.request_id?.toLowerCase(),prompt:input.prompt,timeout_ms:timeout};
}

export class DoubaoTaskService {
  constructor({ store = new TaskStore(), bridge = new DoubaoDesktopBridge() } = {}) { this.store=store;this.bridge=bridge; }
  probe(){return this.bridge.probe();}
  async submit(input){
    const request=normalize(input);const digest=hash(request);const registration=this.store.register(request.request_id,digest,request.timeout_ms);
    if(registration.duplicate)return {...registration.state,duplicate:true};
    let lock;
    try{
      lock=this.store.acquire(request.request_id);
      let state={...registration.state,window_lock_id:lock.lock_id};this.store.write(state);
      const native=await this.bridge.prepareAndSubmit(request.prompt,patch=>{state={...state,...patch};this.store.write(state)});
      state={...state,...native,status:'running',submission:'sent',deadline_at_ms:Date.now()+request.timeout_ms};this.store.write(state);return state;
    }catch(error){
      const current=this.store.read(request.request_id);const mayHaveBeenSent=current.submission==='may_have_been_sent';
      const state={...current,status:mayHaveBeenSent?'unknown':'failed',error:error.code??'submission_failed',retry_safe:false};this.store.write(state);
      if(lock&&!mayHaveBeenSent)this.store.release(lock);
      return state;
    }
  }
  async status(id){
    let state=this.store.read(id);if(terminal.has(state.status))return state;
    if(!state.native_conversation_id||!state.target_id)return state;
    if(Date.now()>state.deadline_at_ms){state={...state,status:'unknown',error:'deadline_remote_state_unknown',retry_safe:false};this.store.write(state);return state;}
    let observed;
    try{observed=await this.bridge.inspect(state.target_id,state.native_conversation_id,state.user_message_index);}
    catch(error){observed={status:'unknown',error:error.code??'result_inspection_failed',retry_safe:false};}
    if(observed.status==='running')return {...state,native_status:'running'};
    state={...state,...observed};this.store.write(state);
    if(observed.status==='succeeded'||observed.status==='failed'){const lock=this.store.lockFor(state.task_id);if(lock)this.store.release(lock);}
    return state;
  }
  async result(id){const state=await this.status(id);return {...state,result:state.status==='succeeded'?{native_conversation_id:state.native_conversation_id,response:state.response,evidence:state.evidence}:null};}
}
