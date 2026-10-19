import path from 'node:path';
import { discover, readSource } from './discovery.js';
import { accountScope, identityEvidence, normalize } from './normalization.js';
import { HistoryRepository } from './repository.js';
import { checkAbort, HistoryError, problem } from './safety.js';
import type { Config } from '../types.js';
import type { JobResult, SyncReport } from './types.js';

export function historyPaths(config:Pick<Config,'databasePath'>):{database:string;exports:string} {
 const base=path.dirname(config.databasePath),database=path.join(base,'history.sqlite');
 if(path.resolve(database)===path.resolve(config.databasePath)) throw new HistoryError('DB_PATH_CONFLICT','任务库不能命名为 history.sqlite；历史层拒绝打开该任务库。');
 return {database,exports:path.join(base,'history-exports')};
}
export async function syncHistory(config:Pick<Config,'databasePath'|'outputDir'>,options:{account?:string;job?:string}={},signal?:AbortSignal):Promise<SyncReport> {
 const explicit=options.account?accountScope(options.account):undefined;
 const jobs=await discover(config.outputDir,options.job);
 const repo=await HistoryRepository.open(historyPaths(config).database,true);
 const report:SyncReport={started_at:new Date().toISOString(),scanned:0,results:[],cancelled:false};
 let run:string|undefined;
 try {
  run=repo.startRun(report);
  for(const jobId of jobs) {
   await new Promise<void>(resolve=>setImmediate(resolve));
   if(signal?.aborted) {report.cancelled=true;break;}
   report.scanned++;
   let result:JobResult={job_id:jobId,result:'ERROR',added:0,revised:0,unchanged:0,rejected:0,issues:[]};
   try {
    const source=await readSource(config.outputDir,jobId);
    const evidence=identityEvidence(source),bound=repo.binding(jobId),scope=explicit??bound?.account_scope;
    if(!scope) throw new HistoryError('ACCOUNT_AMBIGUOUS','首次同步此 Job 请显式使用 --account 本地账号别名；不会根据昵称或目录猜测。');
    if(bound && (scope!==bound.account_scope || bound.identity_hash && evidence!==bound.identity_hash)) throw new HistoryError('ACCOUNT_CONFLICT','Job 已有账号绑定，禁止自动改绑；请核对原始任务。');
    const normalized=normalize(source,scope); result.issues=normalized.issues;
    if((await readSource(config.outputDir,jobId)).fingerprint!==source.fingerprint) throw new HistoryError('SOURCE_CHANGED','读取期间源文件改变；等待原任务结束后重试。');
    checkAbort(signal);
    repo.apply(run,source,scope,evidence,normalized.snapshots,result,signal);
    // Per-note QC is independent of the global batch status. Invalid revisions never replace a valid current revision.
    if(result.issues.length || result.rejected) result.result='IMPORTED_WITH_ISSUES';
   } catch(error) {
    const e=problem(error);
    result={job_id:jobId,result:'ERROR',added:0,revised:0,unchanged:0,rejected:0,issues:[{code:e.code,action:e.action}]};
    repo.failure(run,jobId,result);
    if(e.code==='CANCELLED') report.cancelled=true;
   }
   report.results.push(result);
   if(report.cancelled) break;
  }
  report.finished_at=new Date().toISOString();repo.finishRun(run,report);return report;
 } finally {repo.close();}
}
