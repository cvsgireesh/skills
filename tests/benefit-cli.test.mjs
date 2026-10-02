import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startServer} from '../bin/benefit/server.mjs';

const cli=fileURLToPath(new URL('../bin/intel-skills-benefit.mjs',import.meta.url));
test('configuration stays opt-in and names need explicit detail logging',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'benefit-cli-'));
  const app=await startServer({dataDir:dir,port:0});
  try {
    for(const named of [false,true]) {
      const result=spawnSync(process.execPath,[cli,'config','--data-dir',dir,...(named?['--named-skills']:[])],{encoding:'utf8'});
      assert.equal(result.status,0);
      assert.doesNotMatch(result.stdout,new RegExp(app.token));
      const file=path.join(dir,'claude-settings.json');
      const {env}=JSON.parse(fs.readFileSync(file));
      assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,app.endpoint+'/v1/logs');
      assert.equal(env.OTEL_LOG_TOOL_DETAILS,named?'1':'0');
      assert.equal(env.OTEL_METRICS_EXPORTER,'none');
      assert.equal(env.OTEL_TRACES_EXPORTER,'none');
      assert.equal(env.OTEL_LOG_USER_PROMPTS,'0');
      if(process.platform!=='win32')assert.equal(fs.statSync(file).mode&0o777,0o600);
    }
    assert.equal(app.observer.received,0);
  } finally {
    await new Promise(resolve=>app.server.close(resolve));
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('benchmark arguments cannot masquerade as companion options',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'benefit-options-'));
  try {
    const before=path.join(dir,'before'),after=path.join(dir,'after');
    fs.mkdirSync(before);fs.mkdirSync(after);
    const result=spawnSync(process.execPath,[cli,'compare','--data-dir',dir,'--skill','test-skill','--baseline',before,'--candidate',after,'--metric','runtime','--direction','lower','--',process.execPath,'--unit','ms'],{encoding:'utf8'});
    assert.equal(result.status,1);
    assert.match(result.stderr,/Metric and unit must be explicit/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
