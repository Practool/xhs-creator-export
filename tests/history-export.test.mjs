import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import ExcelJS from 'exceljs';
import {fixture,workspace,writeJob,publicRepo} from './helpers.mjs';import {syncHistory,historyPaths} from '../dist/history/sync.js';import {HistoryRepository} from '../dist/history/repository.js';import {exportHistory} from '../dist/history/export.js';

test('WP06/T12/T16 long/wide/Excel/JSON agree, percentages not rescaled in CSV, formula protection, Chinese titles',async t=>{
 const cfg=await workspace(t),d=fixture('J1',['N1','N2'],[100,0]);d.records[0].row['标题']='=合成中文标题';d.records[1].row['内容类型']='图文';await writeJob(cfg,d);await syncHistory(cfg,{account:'A'});
 const repo=await HistoryRepository.open(historyPaths(cfg).database);t.after(()=>repo.close());
 const output=path.join(cfg.root,'export'),report=await exportHistory(repo,output);assert.equal(report.snapshots,2);
 const json=JSON.parse(await fs.readFile(path.join(output,'history.json'),'utf8')),qc=JSON.parse(await fs.readFile(path.join(output,'history-validation.json'),'utf8'));
 assert.equal(json.snapshots.length,qc.snapshots);assert.ok(qc.metric_scope_unknown>0);
 const csv=await fs.readFile(path.join(output,'history-notes-wide.csv'),'utf8');assert.ok(csv.includes("'=合成中文标题"));assert.ok(csv.includes('26.9'));assert.equal(csv.split('\r\n').length,3);
 const long=await fs.readFile(path.join(output,'history-metrics-long.csv'),'utf8');assert.equal(long.split('\r\n').length,qc.metrics+1);
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.readFile(path.join(output,'history.xlsx'));const metrics=workbook.getWorksheet('Metrics');assert.equal(metrics.rowCount,qc.metrics+1);
 const headers=metrics.getRow(1).values;const key=headers.indexOf('metric_key'),value=headers.indexOf('value');let checked=0;
 metrics.eachRow((r,i)=>{if(i>1&&r.getCell(key).value==='cover_click_rate'){assert.ok(Math.abs(r.getCell(value).value-.269)<1e-12);assert.equal(r.getCell(value).numFmt,'0.00%');checked++;}});assert.equal(checked,2);
 assert.equal(workbook.getWorksheet('Snapshots').rowCount,3);assert.ok(workbook.getWorksheet('Data Dictionary'));
 await assert.rejects(()=>exportHistory(repo,output),/OUTPUT_EXISTS/);
});
test('WP06 audit revision filters, multi-account explicit scope, public paths rejected and aborted exports cleaned',async t=>{
 const cfg=await workspace(t),a=fixture();await writeJob(cfg,a);await syncHistory(cfg,{account:'A'});a.records[0].row['观看数']=110;await writeJob(cfg,a);await syncHistory(cfg);
 const b=fixture('J2');b.job.identityHint=b.records[0].snapshot.identityHint='Synthetic B';await writeJob(cfg,b);await syncHistory(cfg,{job:'J2',account:'B'});
 const repo=await HistoryRepository.open(historyPaths(cfg).database);t.after(()=>repo.close());
 await assert.rejects(()=>exportHistory(repo,path.join(cfg.root,'ambiguous')),/ACCOUNT_AMBIGUOUS/);
 let report=await exportHistory(repo,path.join(cfg.root,'all'),{allAccounts:true});assert.equal(report.snapshots,2);assert.deepEqual(report.account_scopes,['alias:A','alias:B']);
 report=await exportHistory(repo,path.join(cfg.root,'revision'),{account:'A',includeRevisions:true});assert.equal(report.snapshots,2);assert.deepEqual(report.last_sync.results,[]);
 const publicDir=await publicRepo(cfg);await assert.rejects(()=>exportHistory(repo,path.join(publicDir,'docs/history-leak'),{account:'A'}),/PUBLIC_OUTPUT/);
 const c=new AbortController();c.abort();await assert.rejects(()=>exportHistory(repo,path.join(cfg.root,'cancelled'),{account:'A'},c.signal),/CANCELLED/);
 assert.equal(await fs.stat(path.join(cfg.root,'cancelled')).then(()=>true).catch(()=>false),false);
 assert.ok(!(await fs.readdir(cfg.root)).some(n=>n.endsWith('.tmp')));
});
test('WP06 explicit audit includes rejected metrics; missing time stays null in reports',async t=>{
 const cfg=await workspace(t),d=fixture();delete d.job.createdAt;delete d.job.finishedAt;delete d.records[0].snapshot.capturedAt;await writeJob(cfg,d);await syncHistory(cfg,{account:'A'});
 d.records[0].row['观看数']=-1;await writeJob(cfg,d);await syncHistory(cfg);
 const repo=await HistoryRepository.open(historyPaths(cfg).database);t.after(()=>repo.close());
 let report=await exportHistory(repo,path.join(cfg.root,'default'));assert.equal(report.snapshots,1);assert.equal(report.rejected_snapshots,1);assert.equal(report.time_unknown,1);
 report=await exportHistory(repo,path.join(cfg.root,'audit'),{includeInvalid:true});assert.equal(report.snapshots,2);
 const json=JSON.parse(await fs.readFile(path.join(cfg.root,'audit/history.json'),'utf8'));assert.ok(json.snapshots.every(s=>s.observed_at_utc===null));
});

test('WP06 Excel row overflow fails explicitly before publishing any output',async t=>{
 const cfg=await workspace(t),destination=path.join(cfg.root,'too-large');
 // A sparse synthetic result exercises the real export boundary without allocating a million metric objects.
 const repo={status:()=>({accounts:[],last_sync:null}),snapshots:()=>new Array(1048576)};
 await assert.rejects(()=>exportHistory(repo,destination),/EXCEL_ROW_LIMIT/);
 assert.equal(await fs.stat(destination).then(()=>true).catch(()=>false),false);
});
