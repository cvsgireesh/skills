import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Observer} from './observer.mjs';
export function privateDirectory(dir) {
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved,{recursive:true,mode:0o700});
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Data directory must be a real directory');
  if (process.platform !== 'win32' && stat.uid !== process.getuid()) throw new Error('Data directory must be owned by this user');
  fs.chmodSync(resolved,0o700); return resolved;
}
export function writePrivate(file, value) {
  // Atomic replacement avoids following an existing destination symlink.
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'}); fs.renameSync(tmp,file);
}
export async function startServer({dataDir,port=4319,demo=false}) {
  dataDir=privateDirectory(dataDir);
  const lock=path.join(dataDir,'collector.lock');
  const fd=fs.openSync(lock,'wx',0o600); fs.closeSync(fd);
  const token=crypto.randomBytes(24).toString('hex'); const observer=new Observer();
  const ingestion={rejected_exports:0,last_rejected_at:null,last_rejection:null};
  const rejected=reason=>{ingestion.rejected_exports++;ingestion.last_rejected_at=new Date().toISOString();ingestion.last_rejection=reason;};
  const ui=fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),'dashboard.html'));
  function reports() {
    const dir=path.join(dataDir,'comparisons');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f=>/^[a-f0-9-]+\.json$/.test(f)).flatMap(f=>{
      try {const file=path.join(dir,f);const st=fs.lstatSync(file);if(!st.isFile()||st.size>1000000)return [];const report=JSON.parse(fs.readFileSync(file,'utf8'));if(!['completed','failed'].includes(report?.status)||!Number.isFinite(Date.parse(report.finished_at)))return [];return [report];}catch{return [];}
    }).sort((a,b)=>Date.parse(a.finished_at)-Date.parse(b.finished_at)).slice(-50);
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const host=`127.0.0.1:${server.address().port}`;
    const reply=(code,obj)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(obj));};
    if(req.headers.host!==host) return reply(403,{error:'Host rejected'});
    if(req.headers.origin && req.headers.origin!==`http://${host}`) return reply(403,{error:'Origin rejected'});
    if(req.method==='GET'&&req.url==='/') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(ui);}
    if(req.method==='GET'&&req.url==='/api/status') return reply(200,{...observer.snapshot(),ingestion,demo,comparisons:reports()});
    if(req.method!=='POST'||req.url!=='/v1/logs') return reply(404,{error:'Not found'});
    if(req.headers.authorization!==`Bearer ${token}`) return reply(401,{error:'Collector token required'});
    if(!String(req.headers['content-type']).startsWith('application/json')) {rejected('unsupported-format');return reply(415,{error:'OTLP http/json required'});}
    try {
      const chunks=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>2*1024*1024){rejected('oversized-export');reply(413,{error:'Payload too large'});return;}chunks.push(chunk);}
      observer.accept(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      writePrivate(path.join(dataDir,'observed.json'),observer.snapshot());reply(200,{});
    }catch(error){rejected(error.code==='CAPTURE_LIMIT'?'capture-limit':'invalid-export');return reply(400,{error:observer.limitReached?'Capture limit reached; restart for a new capture':'Invalid or unsupported export; raw content not retained'});}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  try {await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}
  catch(e){fs.rmSync(lock,{force:true});throw e;}
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  writePrivate(path.join(dataDir,'connection.json'),{endpoint,token,pid:process.pid});
  server.on('close',()=>{fs.rmSync(lock,{force:true});fs.rmSync(path.join(dataDir,'connection.json'),{force:true});});
  return {server,observer,endpoint,token};
}
