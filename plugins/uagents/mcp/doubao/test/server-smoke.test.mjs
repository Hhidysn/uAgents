import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const base=path.resolve('../../../../.local/test-runs');
test('bundled stdio server initializes and lists only implemented tools',async()=>{
  fs.mkdirSync(base,{recursive:true});const root=fs.mkdtempSync(path.join(base,'doubao-mcp-'));
  const child=spawn(process.execPath,['dist/server.mjs'],{cwd:path.resolve('.'),env:{...process.env,UAGENTS_STATE_DIR:root},stdio:['pipe','pipe','pipe'],windowsHide:true});
  let buffer='';const messages=[];let wake;
  child.stdout.on('data',chunk=>{buffer+=chunk.toString('utf8');let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line.trim()){messages.push(JSON.parse(line));wake?.();wake=undefined;}}});
  const wait=id=>new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error(`timeout waiting for ${id}`)),5000);const check=()=>{const found=messages.find(item=>item.id===id);if(found){clearTimeout(deadline);resolve(found);}else wake=check;};check();});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  try{
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2026-07-28',capabilities:{},clientInfo:{name:'uagents-test',version:'1.0.0'}}});
    const initialized=await wait(1);assert.equal(initialized.result.serverInfo.name,'uagents-doubao-work');
    send({jsonrpc:'2.0',method:'notifications/initialized'});send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
    const listed=await wait(2);assert.deepEqual(listed.result.tools.map(tool=>tool.name).sort(),['doubao_probe','doubao_result','doubao_status','doubao_submit']);
  }finally{child.stdin.end();await new Promise(resolve=>{child.once('close',resolve);setTimeout(()=>{child.kill();resolve();},2000).unref();});fs.rmSync(root,{recursive:true,force:true});}
});

test('bundled stdio server initializes without host-injected state variables',async()=>{
  fs.mkdirSync(base,{recursive:true});const home=fs.mkdtempSync(path.join(base,'doubao-home-'));
  const env={...process.env,HOME:home,USERPROFILE:home};delete env.PLUGIN_DATA;delete env.UAGENTS_STATE_DIR;
  const child=spawn(process.execPath,['dist/server.mjs'],{cwd:path.resolve('.'),env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let buffer='';const messages=[];let wake;
  child.stdout.on('data',chunk=>{buffer+=chunk.toString('utf8');let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line.trim()){messages.push(JSON.parse(line));wake?.();wake=undefined;}}});
  const wait=id=>new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error(`timeout waiting for ${id}`)),5000);const check=()=>{const found=messages.find(item=>item.id===id);if(found){clearTimeout(deadline);resolve(found);}else wake=check;};check();});
  try{
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'uagents-host-test',version:'1'}}})+'\n');
    const initialized=await wait(1);assert.equal(initialized.result?.serverInfo?.name,'uagents-doubao-work');
    assert.equal(fs.statSync(path.join(home,'.uagents','doubao-work','tasks')).isDirectory(),true);
  }finally{child.stdin.end();await new Promise(resolve=>{child.once('close',resolve);setTimeout(()=>{child.kill();resolve();},2000).unref();});fs.rmSync(home,{recursive:true,force:true});}
});
