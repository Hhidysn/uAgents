import { fileURLToPath } from 'node:url';
import { readJson } from '../../plugins/uagents/skills/agent-dispatch/scripts/store.mjs';
import { work } from '../../plugins/uagents/skills/agent-dispatch/scripts/worker.mjs';
const directory=process.argv[2], state=readJson(`${directory}/state.json`), request=readJson(`${directory}/inbox.json`);
await work(directory,{command:process.execPath,args:[fileURLToPath(new URL('./fake-cli.mjs',import.meta.url)),state.target,state.task_id,request.kind==='probe'?'probe':request.prompt]});
