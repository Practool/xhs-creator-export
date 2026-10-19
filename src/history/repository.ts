import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkAbort, HistoryError, noSymlinks, privateDestination } from './safety.js';
import type { JobResult, NormalizedSnapshot, Snapshot, Source, SyncReport } from './types.js';

export class HistoryRepository {
 private constructor(readonly db: Database.Database) {}
 static async open(filename:string, create=false):Promise<HistoryRepository> {
  await noSymlinks(filename);
  if(create) {await privateDestination(filename);await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});}
  else if(!await fs.stat(filename).then(s=>s.isFile()).catch(()=>false)) throw new HistoryError('HISTORY_MISSING','先执行 history sync 建立历史库。');
  const db=new Database(filename,{fileMustExist:!create,timeout:1000});
  try {
   db.pragma('foreign_keys = ON');
   const version=db.pragma('user_version',{simple:true}) as number;
   if(version>1) throw new HistoryError('DB_VERSION_NEWER','历史库由更高版本创建；请升级程序，不要删除数据库。');
   if(version===0) {
    if(!create) throw new HistoryError('DB_SCHEMA_UNKNOWN','空历史库尚未初始化；执行 history sync。');
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    if(tables.length) throw new HistoryError('DB_SCHEMA_UNKNOWN','保留数据库，核对其来源；不自动覆盖未知结构。');
    db.transaction(()=>{
     db.exec(`CREATE TABLE history_schema(schema_version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE accounts(account_scope TEXT PRIMARY KEY,scope_source TEXT NOT NULL);
      CREATE TABLE job_bindings(job_id TEXT PRIMARY KEY,account_scope TEXT NOT NULL REFERENCES accounts,identity_hash TEXT);
      CREATE TABLE notes(account_scope TEXT NOT NULL REFERENCES accounts,note_id TEXT NOT NULL,PRIMARY KEY(account_scope,note_id));
      CREATE TABLE import_runs(import_id TEXT PRIMARY KEY,started_at TEXT NOT NULL,finished_at TEXT,result TEXT NOT NULL);
      CREATE TABLE source_imports(id INTEGER PRIMARY KEY,import_id TEXT NOT NULL REFERENCES import_runs,job_id TEXT NOT NULL,account_scope TEXT,
       source_fingerprint TEXT,source_path TEXT,result TEXT NOT NULL);
      CREATE INDEX source_fingerprint ON source_imports(account_scope,job_id,source_fingerprint);
      CREATE TABLE note_snapshots(snapshot_id TEXT PRIMARY KEY,account_scope TEXT NOT NULL,note_id TEXT NOT NULL,job_id TEXT NOT NULL,
       revision INTEGER NOT NULL CHECK(revision>0),is_current INTEGER NOT NULL CHECK(is_current IN(0,1)),quality_status TEXT NOT NULL,
       business_fingerprint TEXT NOT NULL,body TEXT NOT NULL,
       FOREIGN KEY(account_scope,note_id) REFERENCES notes(account_scope,note_id), UNIQUE(account_scope,note_id,job_id,revision));
      CREATE UNIQUE INDEX uq_snapshot_current ON note_snapshots(account_scope,note_id,job_id) WHERE is_current=1;
      CREATE TABLE metric_observations(snapshot_id TEXT NOT NULL REFERENCES note_snapshots,metric_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(snapshot_id,metric_key));
      PRAGMA user_version=1;`);
     db.prepare('INSERT INTO history_schema VALUES(1,?)').run(new Date().toISOString());
    })();
   }
   // v1 is the only supported schema. No existing-schema migration is attempted without a backup/migration implementation.
   for(const table of ['history_schema','accounts','job_bindings','notes','import_runs','source_imports','note_snapshots','metric_observations'])
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new HistoryError('DB_SCHEMA_INVALID','历史表结构损坏；保留原库并运行 verify。');
   if(!(db.prepare('SELECT schema_version FROM history_schema').all() as any[]).some(r=>r.schema_version===1)) throw new HistoryError('DB_SCHEMA_INVALID','迁移元信息不一致。');
   db.pragma('journal_mode = WAL');
   await fs.chmod(filename,0o600);
   return new HistoryRepository(db);
  } catch(error) {db.close();throw error;}
 }
 binding(job:string):{account_scope:string;identity_hash:string|null}|undefined {return this.db.prepare('SELECT * FROM job_bindings WHERE job_id=?').get(job) as any;}
 startRun(report:SyncReport):string {const id=randomUUID();this.db.prepare('INSERT INTO import_runs VALUES(?,?,NULL,?)').run(id,report.started_at,JSON.stringify(report));return id;}
 finishRun(id:string,report:SyncReport):void {this.db.prepare('UPDATE import_runs SET finished_at=?,result=? WHERE import_id=?').run(new Date().toISOString(),JSON.stringify(report),id);}
 failure(run:string,job:string,result:JobResult):void {this.db.prepare('INSERT INTO source_imports(import_id,job_id,result) VALUES(?,?,?)').run(run,job,JSON.stringify(result));}
 apply(run:string,source:Source,scope:string,evidence:string|null,snapshots:NormalizedSnapshot[],result:JobResult,signal?:AbortSignal):void {
  this.db.transaction(()=>{
   const bound=this.binding(source.jobId);
   if(bound && (bound.account_scope!==scope || bound.identity_hash && evidence!==bound.identity_hash)) throw new HistoryError('ACCOUNT_CONFLICT','Job 已绑定其他作用域或账号证据改变；禁止自动改绑。');
   this.db.prepare('INSERT OR IGNORE INTO accounts VALUES(?,?)').run(scope,'explicit_local_alias');
   this.db.prepare('INSERT OR IGNORE INTO job_bindings VALUES(?,?,?)').run(source.jobId,scope,evidence);
   if(evidence && !bound?.identity_hash) this.db.prepare('UPDATE job_bindings SET identity_hash=? WHERE job_id=?').run(evidence,source.jobId);
   for(const normalized of snapshots) {
    checkAbort(signal);
    const latest=this.db.prepare('SELECT * FROM note_snapshots WHERE account_scope=? AND note_id=? AND job_id=? ORDER BY revision DESC LIMIT 1')
     .get(scope,normalized.note_id,source.jobId) as any;
    if(latest?.business_fingerprint===normalized.business_fingerprint) {result.unchanged++;continue;}
    this.db.prepare('INSERT OR IGNORE INTO notes VALUES(?,?)').run(scope,normalized.note_id);
    const valid=normalized.quality_status!=='needs_review';
    const snapshot:Snapshot={...normalized,snapshot_id:randomUUID(),revision:(latest?.revision??0)+1,is_current:valid?1:0,imported_at:new Date().toISOString(),source_fingerprint:source.fingerprint};
    if(valid) this.db.prepare('UPDATE note_snapshots SET is_current=0 WHERE account_scope=? AND note_id=? AND job_id=? AND is_current=1').run(scope,normalized.note_id,source.jobId);
    const {metrics,...body}=snapshot;
    this.db.prepare('INSERT INTO note_snapshots VALUES(?,?,?,?,?,?,?,?,?)').run(snapshot.snapshot_id,scope,snapshot.note_id,source.jobId,snapshot.revision,snapshot.is_current,snapshot.quality_status,snapshot.business_fingerprint,JSON.stringify(body));
    for(const metric of metrics) this.db.prepare('INSERT INTO metric_observations VALUES(?,?,?)').run(snapshot.snapshot_id,metric.metric_key,JSON.stringify(metric));
    if(!valid) result.rejected++; else if(latest) result.revised++;else result.added++;
   }
   result.result=result.issues.length||result.rejected?'IMPORTED_WITH_ISSUES':result.added+result.revised?'IMPORTED':'SKIPPED_UNCHANGED';
   this.db.prepare('INSERT INTO source_imports(import_id,job_id,account_scope,source_fingerprint,source_path,result) VALUES(?,?,?,?,?,?)')
    .run(run,source.jobId,scope,source.fingerprint,source.root,JSON.stringify(result));
   checkAbort(signal);
  })();
 }
 snapshots(options:{account?:string;includeRevisions?:boolean;includeInvalid?:boolean}={}):Snapshot[] {
  const where=[options.includeRevisions?(options.includeInvalid?'1=1':"quality_status!='needs_review'"):options.includeInvalid?"(is_current=1 OR quality_status='needs_review')":'is_current=1'];
  if(options.account) where.push('account_scope=?');
  const rows=this.db.prepare('SELECT * FROM note_snapshots WHERE '+where.join(' AND ')+' ORDER BY account_scope,note_id,job_id,revision').all(...(options.account?[options.account]:[])) as any[];
  const metrics=this.db.prepare('SELECT body FROM metric_observations WHERE snapshot_id=? ORDER BY metric_key');
  return rows.map(r=>({...JSON.parse(r.body),is_current:r.is_current,metrics:(metrics.all(r.snapshot_id) as any[]).map(m=>JSON.parse(m.body))}));
 }
 status():Record<string,unknown> {
  const count=(table:string)=> (this.db.prepare('SELECT COUNT(*) n FROM '+table).get() as any).n;
  return {schema_version:1,accounts:this.db.prepare('SELECT account_scope FROM accounts ORDER BY account_scope').all(),notes:count('notes'),snapshots:count('note_snapshots'),
   current_snapshots:(this.db.prepare('SELECT COUNT(*) n FROM note_snapshots WHERE is_current=1').get() as any).n,metrics:count('metric_observations'),
   last_sync:(()=>{const r=this.db.prepare('SELECT result FROM import_runs ORDER BY rowid DESC LIMIT 1').get() as any;return r?JSON.parse(r.result):null;})()};
 }
 verify():{ok:boolean;issues:string[]} {
  const issues:string[]=[];
  if(this.db.pragma('integrity_check',{simple:true})!=='ok') issues.push('SQLITE_INTEGRITY');
  if((this.db.pragma('foreign_key_check') as any[]).length) issues.push('FOREIGN_KEY');
  const index=this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='uq_snapshot_current'").get() as any;
  if(!index || !/UNIQUE.*WHERE is_current\s*=\s*1/i.test(index.sql)) issues.push('CURRENT_INDEX_MISSING');
  for(const [table,expected] of [['notes',['account_scope','note_id']],['metric_observations',['snapshot_id','metric_key']]] as const) {
   const keys=(this.db.pragma(`table_info(${table})`) as any[]).filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
   if(keys.join(',')!==expected.join(',')) issues.push('PRIMARY_KEY_INVALID');
  }
  const indexes=this.db.pragma('index_list(note_snapshots)') as any[];
  if(!indexes.some(i=>i.unique && (this.db.pragma(`index_info("${String(i.name).replaceAll('"','""')}")`) as any[]).map(c=>c.name).join(',')==='account_scope,note_id,job_id,revision')) issues.push('REVISION_INDEX_MISSING');
  for(const row of this.db.prepare('SELECT * FROM note_snapshots').all() as any[]) {
   const body=JSON.parse(row.body);
   if(['snapshot_id','account_scope','note_id','job_id','revision','quality_status','business_fingerprint'].some(k=>body[k]!==row[k])) issues.push('SNAPSHOT_METADATA');
  }
  for(const row of this.db.prepare('SELECT metric_key,body FROM metric_observations').all() as any[]) if(JSON.parse(row.body).metric_key!==row.metric_key) issues.push('METRIC_METADATA');

  if((this.db.prepare('SELECT 1 FROM note_snapshots WHERE is_current=1 GROUP BY account_scope,note_id,job_id HAVING COUNT(*)>1').all()).length) issues.push('CURRENT_DUPLICATE');
  for(const s of this.snapshots({includeRevisions:true,includeInvalid:true})) {
   const {snapshot_id,revision,is_current,imported_at,source_fingerprint,business_fingerprint,...business}=s;
   if(snapshotFingerprint(business)!==business_fingerprint) issues.push('SNAPSHOT_FINGERPRINT');
   if(s.is_current && s.quality_status==='needs_review') issues.push('INVALID_CURRENT');
   const binding=this.binding(s.job_id);
   if(binding?.account_scope!==s.account_scope) issues.push('ACCOUNT_BINDING');
  }
  return {ok:!issues.length,issues:[...new Set(issues)]};
 }
 close():void {this.db.close();}
}
import { snapshotFingerprint } from './normalization.js';
