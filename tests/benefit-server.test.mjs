import http from 'node:http';import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {startServer} from '../bin/benefit/server.mjs';
test('loopback collector rejects cross-origin and unauthenticated ingestion; persists no raw content',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'benefit-'));const app=await startServer({dataDir:dir,port:0});try{
 assert.equal(app.server.address().address,'127.0.0.1');
 let r=await fetch(app.endpoint+'/v1/logs',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,401);
 r=await fetch(app.endpoint+'/api/status',{headers:{Origin:'https://example.com'}});assert.equal(r.status,403);
 const hostStatus=await new Promise((resolve,reject)=>{const q=http.get(app.endpoint+'/api/status',{headers:{Host:'attacker.test'}},response=>{response.resume();resolve(response.statusCode);});q.on('error',reject);});assert.equal(hostStatus,403);
 const p={resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:'1',body:{stringValue:'SECRET'},attributes:[{key:'session.id',value:{stringValue:'sess'}},{key:'event.name',value:{stringValue:'skill_activated'}},{key:'skill.name',value:{stringValue:'linux-perf'}}]}]}]}]};
 r=await fetch(app.endpoint+'/v1/logs',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+app.token},body:JSON.stringify(p)});assert.equal(r.status,200);assert.doesNotMatch(fs.readFileSync(path.join(dir,'observed.json'),'utf8'),/SECRET/);
 assert.equal((await(await fetch(app.endpoint+'/api/status')).json()).received,1);
 await assert.rejects(startServer({dataDir:dir,port:0}),/EEXIST/);
 }finally{await new Promise(r=>app.server.close(r));fs.rmSync(dir,{recursive:true,force:true});}});

test('latest comparisons are retained by completion time, not random filename',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'benefit-history-'));const app=await startServer({dataDir:dir,port:0});
 try {
  fs.mkdirSync(path.join(dir,'comparisons'));
  for(let i=0;i<51;i++)fs.writeFileSync(path.join(dir,'comparisons',i.toString(16).padStart(8,'0')+'.json'),JSON.stringify({status:'completed',skill:'case-'+i,finished_at:new Date(Date.UTC(2026,0,1,0,0,51-i)).toISOString()}));
  const {comparisons}=await(await fetch(app.endpoint+'/api/status')).json();
  assert.equal(comparisons.length,50);assert.equal(comparisons.at(-1).skill,'case-0');assert.equal(comparisons.some(r=>r.skill==='case-50'),false);
 }finally{await new Promise(r=>app.server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});

test('authorized rejected exports and capture limits are visible in status',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'benefit-health-'));const app=await startServer({dataDir:dir,port:0});
 try {
  const send=body=>fetch(app.endpoint+'/v1/logs',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+app.token},body:JSON.stringify(body)});
  assert.equal((await send({bad:'PRIVATE'})).status,400);
  let state=await(await fetch(app.endpoint+'/api/status')).json();
  assert.equal(state.ingestion.rejected_exports,1);assert.equal(state.ingestion.last_rejection,'invalid-export');assert.doesNotMatch(JSON.stringify(state),/PRIVATE/);
  app.observer.seen=new Set(Array.from({length:50000},(_,i)=>String(i)));
  const payload={resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:'1',attributes:[{key:'session.id',value:{stringValue:'sess'}},{key:'event.name',value:{stringValue:'api_request'}},{key:'request_id',value:{stringValue:'next'}}]}]}]}]};
  assert.equal((await send(payload)).status,400);
  state=await(await fetch(app.endpoint+'/api/status')).json();
  assert.equal(state.capture_status,'stopped');assert.equal(state.ingestion.last_rejection,'capture-limit');assert.equal(state.last_accepted_at,null);assert.equal(state.received,0);
 }finally{await new Promise(r=>app.server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
