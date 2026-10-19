import { Command } from 'commander';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryRepository } from './repository.js';
import { syncHistory, historyPaths } from './sync.js';
import { exportHistory } from './export.js';
import { problem } from './safety.js';
import type { Config } from '../types.js';

export function registerHistory(program:Command,config:()=>Promise<Config>,signal:AbortSignal):void {
 const history=program.command('history').description('离线手动同步、核验及导出跨 Job 历史快照');
 const run=(action:()=>Promise<void>)=>async()=>{try{await action();}catch(error){const e=problem(error);console.error(e.message);process.exitCode=e.code==='CANCELLED'?130:1;}};
 const sync=history.command('sync').description('只读扫描已导出 Job；首次同步需明确账号别名')
  .option('--account <alias>','首次绑定本地账号别名，不能自动改绑').option('--job <id>','只同步指定 Job');
 sync.action(run(async()=>{
  const report=await syncHistory(await config(),sync.opts(),signal);console.log(JSON.stringify(report,null,2));
  if(report.cancelled) process.exitCode=130;
  else if(report.results.some(r=>r.result==='ERROR'||r.result==='IMPORTED_WITH_ISSUES'))process.exitCode=2;
 }));
 const status=history.command('status').description('历史库统计与最近同步结果（不创建库）');
 status.action(run(async()=>{const repo=await HistoryRepository.open(historyPaths(await config()).database);try{console.log(JSON.stringify(repo.status(),null,2));}finally{repo.close();}}));
 const verify=history.command('verify').description('只诊断历史结构、外键、指纹及当前版本约束');
 verify.action(run(async()=>{const repo=await HistoryRepository.open(historyPaths(await config()).database);try{const result=repo.verify();console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=2;}finally{repo.close();}}));
 const exp=history.command('export').description('导出长表、宽表、Excel、JSON 与 QC 到新私有目录')
  .option('--account <alias>','选择本地账号别名').option('--all-accounts','明确允许多账号输出')
  .option('--include-revisions','包含非当前的有效历史修订').option('--include-invalid','审计视图，包含被拒绝的修订')
  .option('--output <directory>','尚不存在的私有输出目录');
 exp.action(run(async()=>{const cfg=await config(),paths=historyPaths(cfg),opts=exp.opts();
  const repo=await HistoryRepository.open(paths.database);try{
   const destination=opts.output??path.join(paths.exports,'history-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
   console.log(JSON.stringify(await exportHistory(repo,destination,opts,signal),null,2));
  }finally{repo.close();}
 }));
}
