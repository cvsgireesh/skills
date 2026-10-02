#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {startServer, privateDirectory, writePrivate} from './benefit/server.mjs';
import {runComparison} from './benefit/compare.mjs';
const args=process.argv.slice(2); const command=args.shift();
const separator=args.indexOf('--');
const options=separator<0?args:args.slice(0,separator);
const get=(flag,fallback)=>{const i=options.indexOf(flag);if(i<0)return fallback;if(!options[i+1]||options[i+1].startsWith('--'))throw new Error(`${flag} needs a value`);return options[i+1];};
const help=`Skill benefit — local observation and workload comparisons (experimental)

serve   --data-dir <private directory> [--port 4319] [--demo]
config  --data-dir <same directory> [--named-skills]
compare --data-dir <same directory> --skill <name> --baseline <directory>
        --candidate <directory> --metric <name> --unit <unit>
        --direction lower|higher [--repeats 5] [--timeout-ms 30000] -- executable args...

No Claude settings are changed. serve binds only 127.0.0.1.
config writes an opt-in --settings file; nothing is launched or enabled.
--named-skills permits tool details to reach localhost; only allowlisted aggregates
are retained. Check managed exporter policy before using this file with Claude.
compare executes YOUR benchmark in both directories, never an agent replay.
Its final stdout line must be JSON {"value":123,"checks_passed":true}.
No uploads, model calls, automatic feedback, billing or inferred time-saved score.
See docs/local-benefit.md for scope and limits.`;
try {
 if(!command||['help','--help','-h'].includes(command)){console.log(help);process.exit(0);}
 const dir=get('--data-dir');if(!dir)throw new Error('--data-dir is required');
 if(command==='serve') {
  const port=Number(get('--port','4319'));if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid port');
  const app=await startServer({dataDir:dir,port,demo:args.includes('--demo')});
  if(args.includes('--demo')) {
   const attr=(key,val)=>({key,value:{stringValue:String(val)}});
   app.observer.accept({resourceLogs:[{scopeLogs:[{logRecords:[
    {timeUnixNano:'1',attributes:[attr('session.id','synthetic-demo'),attr('event.name','skill_activated'),attr('skill.name','synthetic-demo')]},
    {timeUnixNano:'2',attributes:[attr('session.id','synthetic-demo'),attr('event.name','api_request'),attr('request_id','synthetic-request'),attr('skill.name','synthetic-demo'),attr('cost_usd',0.035)]}
   ]}]}]});
  }
  console.log(`${app.endpoint}\nCapture: ${path.resolve(dir)}\n${args.includes('--demo')?'DEMO data only.':'No runtime telemetry has been enabled.'}`);
  const stop=()=>app.server.close(()=>process.exit(0));process.once('SIGINT',stop);process.once('SIGTERM',stop);
 } else if(command==='config') {
  const root=privateDirectory(dir);const c=JSON.parse(fs.readFileSync(path.join(root,'connection.json'),'utf8'));
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(c.endpoint)||!/^[a-f0-9]{48}$/.test(c.token))throw new Error('Invalid local collector connection');
  const env={CLAUDE_CODE_ENABLE_TELEMETRY:'1',OTEL_METRICS_EXPORTER:'none',OTEL_LOGS_EXPORTER:'otlp',OTEL_TRACES_EXPORTER:'none',CLAUDE_CODE_ENHANCED_TELEMETRY_BETA:'0',ENABLE_ENHANCED_TELEMETRY_BETA:'0',BETA_TRACING_ENDPOINT:'',OTEL_EXPORTER_OTLP_PROTOCOL:'http/json',OTEL_EXPORTER_OTLP_LOGS_PROTOCOL:'http/json',OTEL_EXPORTER_OTLP_ENDPOINT:c.endpoint,OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:c.endpoint+'/v1/logs',OTEL_EXPORTER_OTLP_HEADERS:'',OTEL_EXPORTER_OTLP_LOGS_HEADERS:`Authorization=Bearer ${c.token}`,OTEL_LOGS_EXPORT_INTERVAL:'2000',OTEL_LOG_USER_PROMPTS:'0',OTEL_LOG_ASSISTANT_RESPONSES:'0',OTEL_LOG_TOOL_CONTENT:'0',OTEL_LOG_RAW_API_BODIES:'0',OTEL_LOG_TOOL_DETAILS:args.includes('--named-skills')?'1':'0',OTEL_METRICS_INCLUDE_ACCOUNT_UUID:'false',OTEL_METRICS_INCLUDE_REPOSITORY:'false'};
  const out=path.join(root,'claude-settings.json');writePrivate(out,{env});
  console.log(`Wrote ${out}\nNot activated. To use, explicitly launch Claude with --settings pointing to this file. Managed policies can override it; verify exporter destination first.\n${args.includes('--named-skills')?'Named mode: tool arguments reach the local collector and are discarded, never stored.':'Privacy mode: third-party skill names may be redacted, so named per-skill benefit is unavailable.'}`);
 } else if(command==='compare') {
  const root=privateDirectory(dir);const split=args.indexOf('--');if(split<0)throw new Error('Provide benchmark executable after --');
  const outDir=privateDirectory(path.join(root,'comparisons'));const file=path.join(outDir,crypto.randomUUID()+'.json');
  try {
   const report=await runComparison({baselineDir:get('--baseline'),candidateDir:get('--candidate'),command:args.slice(split+1),skill:get('--skill'),metric:get('--metric'),unit:get('--unit'),direction:get('--direction'),repeats:Number(get('--repeats','5')),timeoutMs:Number(get('--timeout-ms','30000')),onProgress:()=>process.stderr.write('.')});
   writePrivate(file,report);console.log(`\nSaved ${file}\n${JSON.stringify(report.summary,null,2)}\nObserved workload change. Causal skill benefit is not established.`);
  }catch(e){if(e.report)writePrivate(file,e.report);throw e;}
 } else throw new Error(`Unknown command: ${command}`);
}catch(e){console.error(`benefit: ${e.message}`);process.exitCode=1;}
