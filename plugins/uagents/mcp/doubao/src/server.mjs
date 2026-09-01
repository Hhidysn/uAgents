import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { DoubaoTaskService } from './service.mjs';

const expose=value=>value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['digest','window_lock_id'].includes(key))):value;
const response=value=>{const visible=expose(value);return {content:[{type:'text',text:JSON.stringify(visible)}],structuredContent:visible}};
const error=reason=>({content:[{type:'text',text:JSON.stringify({error:reason.code??'internal_error',message:reason.message})}],isError:true,structuredContent:{error:reason.code??'internal_error',message:reason.message}});
const invoke=handler=>async input=>{try{return response(await handler(input))}catch(reason){return error(reason)}};

serveStdio(()=>{
  const service=new DoubaoTaskService();
  const server=new McpServer({name:'uagents-doubao-work',version:'0.1.0-alpha.1'},{capabilities:{tools:{}}});
  server.registerTool('doubao_probe',{description:'Check the prepared Doubao Work CDP connection and identify its single chat target. Does not launch the app or send a task.',inputSchema:z.object({})},invoke(()=>service.probe()));
  server.registerTool('doubao_submit',{description:'Submit one task to a new Doubao Work conversation. Returns quickly after native conversation identity is confirmed; poll status with the same request_id.',inputSchema:z.object({request_id:z.uuid(),prompt:z.string().min(1).max(65536),timeout_ms:z.number().int().min(10000).max(1200000).optional()})},invoke(input=>service.submit(input)));
  server.registerTool('doubao_status',{description:'Inspect only the conversation owned by a previously submitted task. Unknown tasks are never replayed.',inputSchema:z.object({request_id:z.uuid()})},invoke(input=>service.status(input.request_id)));
  server.registerTool('doubao_result',{description:'Return the final response and completion evidence for an owned Doubao Work task when available.',inputSchema:z.object({request_id:z.uuid()})},invoke(input=>service.result(input.request_id)));
  return server;
},{onerror:reason=>process.stderr.write(`uagents doubao mcp: ${reason.message}\n`)});
