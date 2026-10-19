import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import Database from 'better-sqlite3';
import {fixture,workspace,writeJob,source,metric,publicRepo} from './helpers.mjs';
import {normalize,parseTime,identityEvidence,accountScope} from '../dist/history/normalization.js';
import {readSource,discover} from '../dist/history/discovery.js';
import {HistoryRepository} from '../dist/history/repository.js';
import {privateDestination,readJson} from '../dist/history/safety.js';

test('WP01/T09/T10 time source, UTC, Shanghai, invalid dates, missing time',()=>{
 const d=fixture();let n=normalize(source(d),'alias:A').snapshots[0];assert.equal(n.observed_at_utc,'2026-10-01T02:00:00.000Z');assert.equal(n.timestamp_source,'snapshot.capturedAt');
 delete d.records[0].snapshot.capturedAt;n=normalize(source(d),'alias:A').snapshots[0];assert.equal(n.time_precision,'job_time_approx');
 delete d.job.createdAt;delete d.job.finishedAt;n=normalize(source(d),'alias:A').snapshots[0];assert.equal(n.observed_at_utc,null);assert.equal(n.time_precision,'unknown');
 assert.equal(parseTime('2026-10-01 00:30:00',true),'2026-09-30T16:30:00.000Z');assert.equal(parseTime('2026-02-30T12:00:00Z'),null);assert.equal(parseTime('2026-10-01T12:00:00'),null);
 d.records[0].row['采集时间']='2026-10-01 10:00:00';assert.equal(normalize(source(d),'alias:A').snapshots[0].timestamp_source,'row.采集时间');
});
test('WP01/T11/T12/T12b units, zero, null, not applicable, failed, unknown scope',()=>{
 const d=fixture();const row=d.records[0].row;row['观看数']=0;row['内容类型']='图文';row['完播率']=42;row['来源_推荐_观看数']=null;row['观看来源状态']='平台未提供';row['画像_年龄_合成_占比']=null;row['观众画像状态']='读取失败';
 const s=normalize(source(d),'alias:A').snapshots[0];assert.equal(metric(s,'view_count').value,0);assert.equal(metric(s,'full_view_rate').value_status,'not_applicable');assert.equal(metric(s,'full_view_rate').value,null);
 assert.equal(metric(s,'source:来源_推荐_观看数').value_status,'not_available');assert.equal(metric(s,'portrait:画像_年龄_合成_占比').value_status,'collection_failed');
 assert.equal(metric(s,'cover_click_rate').value,26.9);assert.equal(metric(s,'cover_click_rate').unit,'percent_points');assert.equal(metric(s,'view_time_avg_with_double').value_status,'unknown');
 assert.ok(s.metrics.every(m=>m.metric_scope==='unknown'&&m.window_start===null));
 d.job.scope.dates=['2026-10-02','2026-10-09'];assert.equal(normalize(source(d),'alias:A').snapshots[0].business_fingerprint,s.business_fingerprint);
});
test('WP01/T08 identity must be stable ID; mismatched response rejected; mixed account evidence rejected',()=>{
 const d=fixture();delete d.records[0].row['笔记ID'];assert.equal(normalize(source(d),'alias:A').issues[0].code,'NOTE_ID_MISSING');
 const r=fixture();r.records[0].snapshot.responses=[{endpoint:'/note/base',data:{success:true,data:{note_info:{id:'other'}}}}];assert.equal(normalize(source(r),'alias:A').issues[0].code,'NOTE_ID_CONFLICT');
 const c=fixture();c.records[0].snapshot.identityHint='Synthetic B';assert.throws(()=>identityEvidence(source(c)),/ACCOUNT_CONFLICT/);assert.throws(()=>accountScope('../bad'),/INVALID_ACCOUNT/);
});
test('WP04 invalid numbers rejected; unknown fields auditable; canonical property order stable',()=>{
 const d=fixture();d.records[0].row['观看数']='100';let s=normalize(source(d),'alias:A').snapshots[0];assert.equal(s.quality_status,'needs_review');assert.equal(metric(s,'view_count').value_status,'collection_failed');
 d.records[0].row['观看数']=-2;assert.equal(normalize(source(d),'alias:A').snapshots[0].quality_status,'needs_review');
 const original=fixture();original.records[0].row['新指标']=42;s=normalize(source(original),'alias:A').snapshots[0];assert.equal(s.unmapped_fields['新指标'],42);
 original.records[0].row=Object.fromEntries(Object.entries(original.records[0].row).reverse());assert.equal(normalize(source(original),'alias:A').snapshots[0].business_fingerprint,s.business_fingerprint);
});
test('WP03 safe discovery, schema, damaged/oversized source, path escape and symlinks',async t=>{
 const cfg=await workspace(t);const d=fixture();const dir=await writeJob(cfg,d);assert.deepEqual(await discover(cfg.outputDir),['J1']);assert.equal((await readSource(cfg.outputDir,'J1')).jobId,'J1');
 await assert.rejects(()=>readSource(cfg.outputDir,'../bad'),/INVALID_ID/);
 await fs.symlink(dir,path.join(cfg.outputDir,'LINK'));await assert.rejects(()=>readSource(cfg.outputDir,'LINK'),/UNSAFE_PATH/);
 await assert.rejects(()=>readJson(path.join(dir,'content-data.json'),1),/INVALID_SOURCE/);
 await fs.writeFile(path.join(dir,'content-data.json'),'not json');await assert.rejects(()=>readSource(cfg.outputDir,'J1'),/INVALID_JSON/);
 d.schemaVersion=99;await writeJob(cfg,d);await assert.rejects(()=>readSource(cfg.outputDir,'J1'),/INVALID_SCHEMA/);
});
test('WP02 schema initialization idempotent, higher versions rejected, task bytes untouched',async t=>{
 const cfg=await workspace(t);await fs.writeFile(cfg.databasePath,'synthetic task baseline');const before=await fs.readFile(cfg.databasePath);
 const filename=path.join(cfg.root,'history.sqlite');let repo=await HistoryRepository.open(filename,true);assert.equal(repo.verify().ok,true);repo.close();
 repo=await HistoryRepository.open(filename,true);assert.equal(repo.status().snapshots,0);repo.close();assert.deepEqual(await fs.readFile(cfg.databasePath),before);
 const db=new Database(filename);db.pragma('user_version=99');db.close();await assert.rejects(()=>HistoryRepository.open(filename,true),/DB_VERSION_NEWER/);
 const db2=new Database(filename);assert.equal(db2.pragma('user_version',{simple:true}),99);db2.close();
});
test('WP02 transaction rolls back revision and metric insertion on SQLite failure',async t=>{
 const cfg=await workspace(t),repo=await HistoryRepository.open(path.join(cfg.root,'history.sqlite'),true);t.after(()=>repo.close());
 const report={started_at:new Date().toISOString(),scanned:1,results:[],cancelled:false};const run=repo.startRun(report),d=fixture();
 const apply=()=>{const result={job_id:'J1',result:'',added:0,revised:0,unchanged:0,rejected:0,issues:[]};repo.apply(run,source(d),'alias:A',null,normalize(source(d),'alias:A').snapshots,result);};
 apply();d.records[0].row['观看数']=110;
 repo.db.exec("CREATE TRIGGER fail_metric BEFORE INSERT ON metric_observations BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
 assert.throws(apply,/synthetic failure/);const snapshots=repo.snapshots();assert.equal(snapshots.length,1);assert.equal(snapshots[0].revision,1);assert.equal(metric(snapshots[0],'view_count').value,100);
 assert.equal(repo.verify().ok,true);
});
test('WP02 verify detects missing uniqueness index without deleting database',async t=>{
 const cfg=await workspace(t),repo=await HistoryRepository.open(path.join(cfg.root,'history.sqlite'),true);t.after(()=>repo.close());repo.db.exec('DROP INDEX uq_snapshot_current');assert.deepEqual(repo.verify(),{ok:false,issues:['CURRENT_INDEX_MISSING']});
});
test('WP03 outputs reject public Git directories and symlink aliases',async t=>{
 const cfg=await workspace(t),repo=await publicRepo(cfg);
 await assert.rejects(()=>privateDestination(path.join(repo,'docs/private-history')),/PUBLIC_OUTPUT/);
 const originalPath=process.env.PATH;try{process.env.PATH='';await assert.rejects(()=>privateDestination(path.join(repo,'docs/private-history')),/PUBLIC_OUTPUT/);}finally{process.env.PATH=originalPath;}
 await fs.symlink(path.resolve('docs'),path.join(cfg.root,'alias'));await assert.rejects(()=>privateDestination(path.join(cfg.root,'alias','history')),/UNSAFE_PATH/);
});

test('WP03 empty and default-oversized JSON, duplicate records, malformed response shape',async t=>{
 const cfg=await workspace(t),d=fixture(),dir=await writeJob(cfg,d),file=path.join(dir,'content-data.json');
 await fs.writeFile(file,Buffer.from([0x22,0xff,0x22]));await assert.rejects(()=>readSource(cfg.outputDir,'J1'),/INVALID_JSON/);
 await fs.writeFile(file,'');await assert.rejects(()=>readSource(cfg.outputDir,'J1'),/INVALID_SOURCE/);
 await fs.truncate(file,33*1024*1024);await assert.rejects(()=>readSource(cfg.outputDir,'J1'),/INVALID_SOURCE/);
 d.records[0].snapshot.responses={};await writeJob(cfg,d);await assert.rejects(()=>readSource(cfg.outputDir,'J1'),/INVALID_SCHEMA/);
 const repeat=fixture();repeat.records.push(structuredClone(repeat.records[0]));assert.throws(()=>normalize(source(repeat),'alias:A'),/DUPLICATE_NOTE/);
 await assert.rejects(()=>privateDestination(path.resolve('.git/history')),/UNSAFE_PATH/);
});
test('WP04 semantically equal time strings do not manufacture revisions; unknown metrics are not invented',()=>{
 const d=fixture();const before=normalize(source(d),'alias:A').snapshots[0];
 d.records[0].snapshot.capturedAt='2026-10-01T10:00:00+08:00';const after=normalize(source(d),'alias:A').snapshots[0];assert.equal(before.business_fingerprint,after.business_fingerprint);
 d.records[0].row['不明_数值']=123;const n=normalize(source(d),'alias:A').snapshots[0];assert.equal(n.unmapped_fields['不明_数值'],123);assert.equal(n.metrics.some(m=>m.metric_key==='diagnosis:不明_数值'),false);
 d.records[0].row['诊断_合成指标_数值']=-2;const unknown=normalize(source(d),'alias:A').snapshots[0];assert.equal(metric(unknown,'diagnosis:诊断_合成指标_数值').value,-2);
 delete d.records[0].row['观看数'];assert.equal(normalize(source(d),'alias:A').snapshots[0].quality_status,'needs_review');
});
