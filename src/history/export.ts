import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { csvCell } from '../exporter.js';
import { definitions } from './mapping.js';
import { accountScope } from './normalization.js';
import { HistoryRepository } from './repository.js';
import { checkAbort, HistoryError, privateDestination } from './safety.js';
import type { Snapshot } from './types.js';

const metadata=['account_scope','note_id','job_id','snapshot_id','revision','observed_at_utc','time_precision','published_at_utc'];
export const longColumns=[...metadata,'metric_key','value','value_type','unit','value_status','quality_status','source_kind','metric_scope','window_start','window_end',
 'source_field_path','metric_schema_version','timestamp_source','imported_at','source_fingerprint','business_fingerprint'];
export const wideColumns=[...metadata,'title','note_type','quality_status','timestamp_source',...definitions.map(d=>d.key)];
function sheet(workbook:ExcelJS.Workbook,name:string,columns:string[],rows:Record<string,unknown>[],percentage:(row:Record<string,unknown>,column:string)=>boolean):void {
 if(rows.length>1048575) throw new HistoryError('EXCEL_ROW_LIMIT','导出超过 Excel 单表上限；请按账号分别导出，原数据未丢失。');
 const s=workbook.addWorksheet(name,{views:[{state:'frozen',xSplit:3,ySplit:1}]});
 s.columns=columns.map(k=>({header:k,key:k,width:k==='title'?40:24}));
 for(const row of rows) {
  const cells=s.addRow(columns.map(k=>typeof row[k]==='number' && percentage(row,k)?Number(row[k])/100:row[k]??null));
  cells.eachCell((cell,index)=>{if(typeof cell.value==='number') cell.numFmt=percentage(row,columns[index-1])?'0.00%':'0.########';});
 }
 s.getRow(1).font={bold:true};s.autoFilter={from:{row:1,column:1},to:{row:Math.max(rows.length+1,1),column:columns.length}};
}
const toCSV=(columns:string[],rows:Record<string,unknown>[]):string=>'\uFEFF'+[columns,...rows.map(r=>columns.map(c=>r[c]))].map(r=>r.map(csvCell).join(',')).join('\r\n');
export async function exportHistory(repo:HistoryRepository,destination:string,options:{account?:string;allAccounts?:boolean;includeRevisions?:boolean;includeInvalid?:boolean}={},signal?:AbortSignal):Promise<Record<string,unknown>> {
 const scope=options.account?accountScope(options.account):undefined;
 if(scope && options.allAccounts) throw new HistoryError('INVALID_OPTIONS','--account 与 --all-accounts 不能同时使用。');
 const accounts=(repo.status().accounts as {account_scope:string}[]).map(a=>a.account_scope);
 if(!scope && accounts.length>1 && !options.allAccounts) throw new HistoryError('ACCOUNT_AMBIGUOUS','历史库包含多个账号，请用 --account 或显式 --all-accounts。');
 if(scope && !accounts.includes(scope)) throw new HistoryError('ACCOUNT_NOT_FOUND','该账号别名不在历史库中；先同步对应 Job。');
 destination=path.resolve(destination);await privateDestination(destination);
 if(await fs.lstat(destination).then(()=>true).catch((e:any)=>{if(e.code==='ENOENT')return false;throw e;})) throw new HistoryError('OUTPUT_EXISTS','为历史导出选择尚不存在的新目录，避免覆盖已有结果。');
 const snapshots=repo.snapshots({account:scope,includeRevisions:options.includeRevisions,includeInvalid:options.includeInvalid});
 const audit=repo.snapshots({account:scope,includeRevisions:true,includeInvalid:true});
 const metrics:Record<string,unknown>[]=snapshots.flatMap(s=>s.metrics.map(m=>({...Object.fromEntries(metadata.map(k=>[k,s[k as keyof Snapshot]])),...m,
  quality_status:s.quality_status,timestamp_source:s.timestamp_source,imported_at:s.imported_at,source_fingerprint:s.source_fingerprint,business_fingerprint:s.business_fingerprint})));
 const wide:Record<string,unknown>[]=snapshots.map(s=>({...Object.fromEntries(wideColumns.map(k=>[k,s[k as keyof Snapshot]??null])),
  ...Object.fromEntries(s.metrics.filter(m=>definitions.some(d=>d.key===m.metric_key)).map(m=>[m.metric_key,m.value]))}));
 const recent=repo.status().last_sync as any;
 const selectedResults=(recent?.results??[]).filter((r:any)=>!scope || repo.binding(r.job_id)?.account_scope===scope);
 const lastSync=recent?{started_at:recent.started_at,finished_at:recent.finished_at,cancelled:recent.cancelled,results:selectedResults,account_filtered:!!scope}:null;
 const report={schema_version:1,exported_at:new Date().toISOString(),account_scopes:scope?[scope]:accounts,
  include_revisions:!!options.includeRevisions,include_invalid:!!options.includeInvalid,snapshots:snapshots.length,
  jobs:new Set(snapshots.map(s=>s.job_id)).size,notes:new Set(snapshots.map(s=>s.account_scope+'\0'+s.note_id)).size,metrics:metrics.length,
  time_unknown:snapshots.filter(s=>!s.observed_at_utc).length,job_time_approx:snapshots.filter(s=>s.time_precision==='job_time_approx').length,
  metric_scope_unknown:metrics.filter(m=>m.metric_scope==='unknown').length,
  rejected_snapshots:audit.filter(s=>s.quality_status==='needs_review').length,
  excluded_revisions:audit.length-snapshots.length,warnings:[...new Set(snapshots.flatMap(s=>s.warnings))],
  last_sync:lastSync,unbound_source_results:(recent?.results??[]).filter((r:any)=>!repo.binding(r.job_id)).length,comparison_notice:'指标统计窗口 unknown，不自动计算增长、插值或每日表现。'};
 const workbook=new ExcelJS.Workbook();workbook.creator='xhs-creator-export';
 sheet(workbook,'Snapshots',wideColumns,wide,(_,k)=>definitions.some(d=>d.key===k&&d.unit==='percent_points'));
 sheet(workbook,'Metrics',longColumns,metrics,(row,k)=>k==='value'&&row.unit==='percent_points');
 sheet(workbook,'Data Dictionary',['metric_key','source_field_path','value_type','unit','metric_schema_version','metric_scope'],
  [...new Map(snapshots.flatMap(s=>s.metrics).map(m=>[m.metric_key,{metric_key:m.metric_key,source_field_path:m.source_field_path,value_type:m.value_type,unit:m.unit,metric_schema_version:m.metric_schema_version,metric_scope:m.metric_scope}])).values()],()=>false);
 checkAbort(signal);
 await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
 const temporary=path.join(path.dirname(destination),'.history-export-'+randomUUID()+'.tmp');
 await fs.mkdir(temporary,{mode:0o700});
 try {
  const outputs:Record<string,string|Buffer>={
   'history-metrics-long.csv':toCSV(longColumns,metrics),'history-notes-wide.csv':toCSV(wideColumns,wide),
   'history.json':JSON.stringify({schema_version:1,exported_at:report.exported_at,account_scopes:report.account_scopes,qc:report,snapshots},null,2),
   'history-validation.json':JSON.stringify(report,null,2),'history.xlsx':Buffer.from(await workbook.xlsx.writeBuffer()),
  };
  for(const [name,data] of Object.entries(outputs)) {checkAbort(signal);await fs.writeFile(path.join(temporary,name),data,{flag:'wx',mode:0o600});}
  const checked=new ExcelJS.Workbook();await checked.xlsx.readFile(path.join(temporary,'history.xlsx'));
  if(checked.getWorksheet('Snapshots')!.rowCount!==snapshots.length+1 || checked.getWorksheet('Metrics')!.rowCount!==metrics.length+1) throw new HistoryError('EXPORT_FAILED','Excel 行数校验失败，未提交导出。');
  checkAbort(signal);await privateDestination(destination);
  if(await fs.lstat(destination).then(()=>true).catch((e:any)=>{if(e.code==='ENOENT')return false;throw e;})) throw new HistoryError('OUTPUT_EXISTS','输出目录已被其他进程创建，请选择新目录。');
  await fs.rename(temporary,destination);
  return {...report,output:destination};
 } finally {await fs.rm(temporary,{recursive:true,force:true});}
}
