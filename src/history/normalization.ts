import { definitionsFor } from './mapping.js';
import { checkId, fingerprint, HistoryError } from './safety.js';
import { redact } from '../parser.js';
import type { Source, Metric, NormalizedSnapshot, Issue, ValueStatus } from './types.js';

export function accountScope(alias: string): string {
 if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(alias)) throw new HistoryError('INVALID_ACCOUNT', '账号别名需为 1–64 位字母、数字、点、下划线或连字符。');
 return 'alias:'+alias;
}
export function identityEvidence(source: Source): string | null {
 const hints = [source.archive.job.identityHint, ...source.archive.records.map((r: any)=>r.snapshot.identityHint)]
  .filter((v: any)=>typeof v==='string' && v.trim()).map((v: string)=>v.trim().replace(/\s+/g,' '));
 if(new Set(hints).size>1) throw new HistoryError('ACCOUNT_CONFLICT', 'Job 内账号证据冲突；核对原件，不能自动合并。');
 return hints.length ? fingerprint(hints[0]):null;
}
// Unzoned strings are accepted only for the row fields which parser.ts writes in Shanghai time.
export function parseTime(value: unknown, shanghai = false): string | null {
 if(typeof value!=='string') return null;
 const match=value.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(\.\d{1,3})?(Z|[+-]\d\d:\d\d)?$/);
 if(!match || !match[8] && !shanghai) return null;
 const [y,m,d,h,min,s]=match.slice(1,7).map(Number);
 const calendar=new Date(Date.UTC(y,m-1,d));
 if(calendar.getUTCFullYear()!==y || calendar.getUTCMonth()!==m-1 || calendar.getUTCDate()!==d || h>23 || min>59 || s>59) return null;
 if(match[8] && match[8]!=='Z') { const [oh,om]=match[8].slice(1).split(':').map(Number); if(oh>14 || om>59 || oh===14 && om!==0) return null; }
 const epoch=Date.parse(value.replace(' ','T')+(match[8]?'':'+08:00'));
 return Number.isFinite(epoch)?new Date(epoch).toISOString():null;
}
function published(source: Source, record: any, id: string): {utc:string|null;raw:unknown} {
 const note=source.archive.job.notes.find((n:any)=>n.id===id);
 const base=[...(record.snapshot.responses||[])].reverse().find((r:any)=>typeof r.endpoint==='string' && r.endpoint.endsWith('/note/base') && r.data?.success===true)?.data?.data?.note_info;
 if(base && base.id!==id) throw new HistoryError('NOTE_ID_CONFLICT', '详情响应与笔记 ID 不一致；重新导出原 Job。');
 const raw=base?.post_time ?? note?.listData?.post_time ?? record.row['发布时间'] ?? null;
 if(typeof raw==='number' && Number.isFinite(raw)) { const date=new Date(raw); return {utc:Number.isFinite(date.getTime())?date.toISOString():null,raw}; }
 return {utc:parseTime(raw,true),raw};
}
export function normalize(source: Source, scope: string): {snapshots:NormalizedSnapshot[];issues:Issue[]} {
 const snapshots:NormalizedSnapshot[]=[],issues:Issue[]=[],seen=new Set<string>();
 for(const record of source.archive.records) {
  const row=record.row;
  let id:string;
  try { id=checkId(row['笔记ID']); } catch { issues.push({code:'NOTE_ID_MISSING',action:'从原始任务恢复稳定笔记 ID 后重试。'});continue; }
  if(seen.has(id)) throw new HistoryError('DUPLICATE_NOTE','同一 Job 中存在重复笔记记录，先修复原件。');
  seen.add(id);
  if(!source.archive.job.notes.some((n:any)=>n.id===id)) {issues.push({code:'NOTE_ID_CONFLICT',note_id:id,action:'笔记不在该 Job 目录中。'});continue;}
  try {
   const pub=published(source,record,id), warnings:string[]=[];
   let observed:string|null=null, raw:unknown=null, precision='unknown', timestampSource='none';
   for(const [value,key,local] of [[record.snapshot.capturedAt,'snapshot.capturedAt',false],[row['采集时间'],'row.采集时间',true],
    [source.archive.job.finishedAt,'job.finishedAt',false],[source.archive.job.createdAt,'job.createdAt',false]] as const) {
    const time=parseTime(value,local);
    if(time) {observed=time;raw=value;timestampSource=key;precision=key.startsWith('job.')?'job_time_approx':'note_time';break;}
    if(value!=null) warnings.push('INVALID_TIME:'+key);
   }
   if(!observed) warnings.push('TIME_UNKNOWN');
   if(!pub.utc) warnings.push('PUBLISHED_TIME_UNKNOWN');
   warnings.push('METRIC_SCOPE_UNKNOWN');
   if(!source.validation) warnings.push('VALIDATION_MISSING');
   let invalid=false;
   const type=row['内容类型'];
   if(!['视频','图文'].includes(type)) {invalid=true;warnings.push('NOTE_TYPE_UNKNOWN');}
   if(!source.archive.job.completed.includes(id)) {invalid=true;warnings.push('NOT_COMPLETED');}
   const artifactPaths=[...(record.snapshot.officialFiles||[]),...(record.snapshot.coreViewScreenshots||[]),...(record.snapshot.trendScreenshots||[])].map((a:any)=>a.path);
   if(source.validation?.invalidArtifacts?.some((p:unknown)=>artifactPaths.includes(p)) || source.archive.job.errors?.some((e:any)=>e.noteId===id)) {invalid=true;warnings.push('SOURCE_QC_FAILED');}
   const metrics:Metric[]=definitionsFor(row).map((def):Metric=>{
    let value=row[def.field]??null;
    let status:ValueStatus='available';
    const moduleState=def.key.startsWith('source:')?row['观看来源状态']:def.key.startsWith('portrait:')?row['观众画像状态']:
     def.key.startsWith('diagnosis:')?row[def.field.replace(/_(数值|同类中位数|超过同类作者占比)$/,'_诊断结果')]:null;
    if(def.applies && type!==def.applies || moduleState==='不适用') {value=null;status='not_applicable';}
    else if(value===null) {
     if(['impl_count','view_count','like_count','comment_count','collect_count','share_count'].includes(def.key)) {invalid=true;warnings.push('CORE_REQUIRED_UNKNOWN:'+def.key);}
     status=typeof moduleState==='string' && /读取失败|采集失败/.test(moduleState)?'collection_failed':typeof moduleState==='string' && /平台未提供|平台数据不足|暂无数据/.test(moduleState)?'not_available':'unknown';}
    else if(typeof value!=='number' || !Number.isFinite(value) || def.min!=null && value<def.min || def.type==='integer' && !Number.isInteger(value) || def.max!=null && value>def.max) {
     value=null;status='collection_failed';invalid=true;warnings.push('INVALID_METRIC:'+def.key);
    }
    return {metric_key:def.key,value,value_type:def.type,unit:def.unit,value_status:status,source_kind:'page_response',
     source_field_path:'records[].row.'+def.field,metric_schema_version:1,metric_scope:'unknown',window_start:null,window_end:null};
   }).sort((a,b)=>a.metric_key < b.metric_key ? -1 : a.metric_key > b.metric_key ? 1 : 0);
   const defined=new Set(definitionsFor(row).map(d=>d.field));
   const metadata=new Set(['笔记ID','标题','内容类型','发布时间','采集时间','详情地址','指标来源']);
   const unmapped=redact(Object.fromEntries(Object.entries(row).filter(([key])=>!defined.has(key)&&!metadata.has(key))));
   const business={account_scope:scope,note_id:id,job_id:source.jobId,title:typeof row['标题']==='string'?row['标题']:'',note_type:typeof type==='string'?type:'unknown',
    published_at_utc:pub.utc,published_time_raw:pub.raw,observed_at_utc:observed,observed_time_raw:raw,time_precision:precision,timestamp_source:timestampSource,
    quality_status:invalid?'needs_review' as const:warnings.length?'warning' as const:'valid' as const,warnings:[...new Set(warnings)].sort(),metrics,unmapped_fields:unmapped};
   snapshots.push({...business,business_fingerprint:snapshotFingerprint(business)});
   if(invalid) issues.push({code:'SNAPSHOT_REJECTED',note_id:id,action:'质量校验未通过；原有效版本保持不变，请核对原 Job 或导出 --include-invalid 审计视图。'});
  } catch(e) {
   if(e instanceof HistoryError) issues.push({code:e.code,note_id:id,action:e.action}); else throw e;
  }
 }
 for(const id of source.archive.job.completed) if(!seen.has(id)) issues.push({code:'RECORD_MISSING',note_id:id,action:'已完成笔记的记录缺失，重新导出原 Job。'});
 return {snapshots,issues};
}

export function snapshotFingerprint(business:Omit<NormalizedSnapshot,'business_fingerprint'>):string {
 const unmapped=Object.fromEntries(Object.entries(business.unmapped_fields).filter(([key])=> !/截图|^官方/.test(key)));
 const {published_time_raw,observed_time_raw,...semantic}=business;
 return fingerprint({...semantic,unmapped_fields:unmapped});
}
