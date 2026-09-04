import fs from 'node:fs';
const [target, id, scenario] = process.argv.slice(2);
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
if (scenario === 'probe') { console.log('1.2.3'); process.exit(0); }
let input='';
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
  fs.appendFileSync('received.txt', 'submitted\n');
  const session = target === 'workbuddy' ? id : 'ses_fixture';
  if (target === 'workbuddy') emit({type:'system',subtype:'init',session_id:session,cwd:process.cwd(),model:'fixture-default',permissionMode:'acceptEdits'});
  else emit({type:'step_start',sessionID:session,part:{id:'start',messageID:'answer',sessionID:session,type:'step-start'}});
  if(scenario==='hang'){setTimeout(()=>{},15000);return;}
  if(scenario==='malformed'){process.stdout.write('null\n');return;}
  if(scenario==='truncated')return;
  fs.writeFileSync('artifact.txt','独立任务产物');
  if(target==='workbuddy')emit({type:'result',session_id:session,subtype:'success',is_error:false,result:'中文结果 ✓',usage:{total_tokens:0}});
  else {
    if(scenario==='auth-error'){
      emit({
        type:'error',sessionID:session,
        error:{name:'APIError',data:{
          message:"Invalid 'Authorization' header or token.",statusCode:401,
          responseHeaders:{authorization:'Bearer fixture-secret'},responseBody:'token=fixture-secret'
        }}
      });
      process.exitCode=1;
      return;
    }
    emit({type:'text',sessionID:session,part:{id:'text',messageID:'answer',sessionID:session,type:'text',text:'中文结果 ✓'}});
    emit({type:'step_finish',sessionID:session,part:{id:'finish',messageID:'answer',sessionID:session,type:'step-finish',reason:'stop',tokens:{total:0}}});
  }
});
