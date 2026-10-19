import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import Database from 'better-sqlite3';
import {fixture,workspace,writeJob,metric} from './helpers.mjs';
import {syncHistory,historyPaths} from '../dist/history/sync.js';import {HistoryRepository} from '../dist/history/repository.js';
async function read(cfg,fn){const r=await HistoryRepository.open(historyPaths(cfg).database);try{return await fn(r);}finally{r.close();}}

test('WP05/T01-T04 new jobs same note, zero, idempotence, single-note revision, nonsemantic source changes',async t=>{
 const cfg=await workspace(t),j1=fixture(),j2=fixture('J2',['N1','N2'],[160,0]);j2.records[0].snapshot.capturedAt='2026-10-03T02:00:00Z';await writeJob(cfg,j1);await writeJob(cfg,j2);
 let r=await syncHistory(cfg,{account:'A'});assert.equal(r.results.reduce((n,j)=>n+j.added,0),3);
 r=await syncHistory(cfg);assert.ok(r.results.every(j=>j.result==='SKIPPED_UNCHANGED'));
 const dir=path.join(cfg.outputDir,'J1');await fs.writeFile(path.join(dir,'changed.zip'),'synthetic');await fs.utimes(path.join(dir,'changed.zip'),new Date(),new Date());
 let validation=JSON.parse(await fs.readFile(path.join(dir,'validation.json'),'utf8'));validation.verifiedAt=new Date().toISOString();await fs.writeFile(path.join(dir,'validation.json'),JSON.stringify(validation));
 r=await syncHistory(cfg);assert.ok(r.results.every(j=>j.result==='SKIPPED_UNCHANGED'));
 j1.records[0].row['观看数']=110;await writeJob(cfg,j1);r=await syncHistory(cfg,{job:'J1'});assert.equal(r.results[0].revised,1);
 await read(cfg,repo=>{const s=repo.snapshots(),all=repo.snapshots({includeRevisions:true});assert.equal(s.length,3);assert.equal(all.length,4);
  assert.equal(metric(s.find(x=>x.job_id==='J1'),'view_count').value,110);assert.equal(metric(s.find(x=>x.job_id==='J2'&&x.note_id==='N1'),'view_count').value,160);
  assert.equal(metric(s.find(x=>x.note_id==='N2'),'view_count').value,0);assert.equal(repo.verify().ok,true);});
 j2.records[0].row['观看数']=170;await writeJob(cfg,j2);r=await syncHistory(cfg,{job:'J2'});assert.equal(r.results[0].revised,1);assert.equal(r.results[0].unchanged,1);
});
test('WP05/T05-T07 explicit aliases, mixed evidence, fixed job binding across runs',async t=>{
 const cfg=await workspace(t),a=fixture();await writeJob(cfg,a);let r=await syncHistory(cfg);assert.equal(r.results[0].issues[0].code,'ACCOUNT_AMBIGUOUS');
 await syncHistory(cfg,{account:'A'});r=await syncHistory(cfg,{account:'B'});assert.equal(r.results[0].issues[0].code,'ACCOUNT_CONFLICT');
 const b=fixture('J3');b.job.identityHint=b.records[0].snapshot.identityHint='Synthetic account B';await writeJob(cfg,b);await syncHistory(cfg,{account:'B',job:'J3'});
 await read(cfg,repo=>{assert.equal(repo.status().notes,2);assert.equal(repo.snapshots().length,2);});
 a.job.identityHint=a.records[0].snapshot.identityHint='Changed evidence';await writeJob(cfg,a);r=await syncHistory(cfg,{account:'A',job:'J1'});assert.equal(r.results[0].issues[0].code,'ACCOUNT_CONFLICT');
});
test('WP05/T08/T14 corrupt jobs isolated; rejected revisions do not replace current; missing source does not delete history',async t=>{
 const cfg=await workspace(t),d=fixture();await writeJob(cfg,d);await syncHistory(cfg,{account:'A'});
 d.records[0].row['观看数']='bad';await writeJob(cfg,d);let r=await syncHistory(cfg);assert.equal(r.results[0].rejected,1);
 await read(cfg,repo=>{assert.equal(repo.snapshots()[0].revision,1);assert.equal(repo.snapshots({includeInvalid:true}).length,2);assert.equal(repo.verify().ok,true);});
 r=await syncHistory(cfg);assert.equal(r.results[0].rejected,0);assert.equal(r.results[0].unchanged,1);assert.equal(r.results[0].result,'IMPORTED_WITH_ISSUES');
 delete d.records[0].row['笔记ID'];await writeJob(cfg,d);r=await syncHistory(cfg);assert.equal(r.results[0].issues[0].code,'NOTE_ID_MISSING');
 await fs.writeFile(path.join(cfg.outputDir,'J1','content-data.json'),'broken JSON');await writeJob(cfg,fixture('J2'));r=await syncHistory(cfg,{account:'A'});assert.equal(r.results[0].result,'ERROR');assert.equal(r.results[1].added,1);
 await fs.rm(path.join(cfg.outputDir,'J1'),{recursive:true});r=await syncHistory(cfg,{account:'A'});await read(cfg,repo=>assert.equal(repo.snapshots().length,2));
});
test('WP05/T13 cancellation between jobs is restartable; no duplicate current snapshots',async t=>{
 const cfg=await workspace(t);await writeJob(cfg,fixture());await writeJob(cfg,fixture('J2'));
 const c=new AbortController();c.abort();const r=await syncHistory(cfg,{account:'A'},c.signal);assert.equal(r.cancelled,true);assert.equal(r.scanned,0);
 await syncHistory(cfg,{account:'A'});await syncHistory(cfg);await read(cfg,repo=>assert.equal(repo.snapshots().length,2));
});
test('WP05/T15 locked database produces diagnostic; source is not modified',async t=>{
 const cfg=await workspace(t);const dir=await writeJob(cfg,fixture());await syncHistory(cfg,{account:'A'});const before=await fs.readFile(path.join(dir,'content-data.json'));
 const lock=new Database(historyPaths(cfg).database);lock.exec('BEGIN IMMEDIATE');try{await assert.rejects(()=>syncHistory(cfg),e=>e.code==='SQLITE_BUSY'||e.code==='SQLITE_LOCKED');}finally{lock.exec('ROLLBACK');lock.close();}
 assert.deepEqual(await fs.readFile(path.join(dir,'content-data.json')),before);
});
test('WP05 partial/cancelled/waiting jobs are judged by per-note QC, not batch status',async t=>{
 const cfg=await workspace(t);for(const status of ['partial','cancelled','waiting_for_user','complete_with_warnings']) {const d=fixture('J_'+status);d.job.status=status;await writeJob(cfg,d);}
 const r=await syncHistory(cfg,{account:'A'});assert.equal(r.results.reduce((n,j)=>n+j.added,0),4);
 await read(cfg,repo=>assert.equal(repo.snapshots().length,4));
});
test('WP05 changes to screenshot paths alone do not manufacture a business revision',async t=>{
 const cfg=await workspace(t),d=fixture();d.records[0].row['核心观看数_按天_截图']='old.png';await writeJob(cfg,d);await syncHistory(cfg,{account:'A'});
 d.records[0].row['核心观看数_按天_截图']='renamed.png';await writeJob(cfg,d);const r=await syncHistory(cfg);assert.equal(r.results[0].result,'SKIPPED_UNCHANGED');
});
