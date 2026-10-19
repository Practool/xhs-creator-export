import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {EventEmitter} from 'node:events';import {spawnSync} from 'node:child_process';
import ExcelJS from 'exceljs';
import {workspace,fixture} from './helpers.mjs';import {Store} from '../dist/store.js';import {extractNote} from '../dist/parser.js';import {collect} from '../dist/runner.js';import {saveArtifact} from '../dist/files.js';import {XhsAdapter} from '../dist/adapter.js';import {ResponseCollector} from '../dist/browser.js';
import {syncHistory,historyPaths} from '../dist/history/sync.js';import {HistoryRepository} from '../dist/history/repository.js';
const cli=path.resolve('dist/cli.js');

test('WP08/T17 upgrade: init/doctor/status/export and offline mocked resume/retry preserve legacy task semantics',async t=>{
 const cfg=await workspace(t);await fs.mkdir(cfg.outputDir);const config=path.join(cfg.root,'config.yaml');
 const run=args=>spawnSync(process.execPath,[cli,'-c',config,...args],{cwd:cfg.root,encoding:'utf8',timeout:20000});
 let result=run(['init']);assert.equal(result.status,0,result.stderr);
 const options={browser:'auto',profileDir:path.join(cfg.root,'profile'),databasePath:cfg.databasePath,outputDir:cfg.outputDir,headless:true,intervalMs:0,operationTimeoutMs:1000,downloadTimeoutMs:1000,stepRetries:0,noteRestarts:0,dateStrategy:'platform'};
 await fs.writeFile(config,JSON.stringify(options));result=run(['doctor']);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).sqlite,'ok');
 const data=fixture(),job=data.job;job.requestedDates=job.scope.dates;job.notes[0].listData={post_time:Date.parse('2026-10-01T00:00:00Z')};
 const store=new Store(cfg.databasePath,cfg.outputDir),root=store.root(job.id);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6QAAAAABJRU5ErkJggg==','base64');
 const workbook=new ExcelJS.Workbook();workbook.addWorksheet('data').addRow(['笔记ID','观看数']);const excel=Buffer.from(await workbook.xlsx.writeBuffer());
 const screenshot=(relative,mode)=>saveArtifact(root,relative,png,{kind:'screenshot',complete:true,mode});
 const snapshot={url:'https://example.invalid/N1',capturedAt:'2026-10-01T02:00:00Z',identityHint:job.identityHint,
  responses:[{endpoint:'/note/base',data:{success:true,data:{note_info:{id:'N1',type:'VIDEO',post_time:Date.parse('2026-10-01T00:00:00Z')},impl_count:200,view_count:100,like_count:0,comment_count:0,collect_count:0,share_count:0,analyse_infos:[]}}},
   {endpoint:'/note/audience/source',data:{success:true,data:{no_data:true}}},{endpoint:'/note/audience/source/detail',data:{success:true,data:{no_data:true}}}],diagnoses:[],
  officialFiles:[await saveArtifact(root,'official/N1.xlsx',excel,{kind:'official'})],coreViewScreenshots:[await screenshot('core-view-trends/hour/N1/full.png','按小时'),await screenshot('core-view-trends/day/N1/full.png','按天')],trendScreenshots:[await screenshot('trends/N1/full.png')]};
 job.officialFiles=[await saveArtifact(root,'official/note-list.xlsx',excel,{kind:'official'})];
 store.commit(job,'N1',{row:extractNote(snapshot,job.notes[0]),snapshot});store.close();
 const mocked={gotoList:async()=>{},gotoNote:async()=>{},assertIdentity:async()=>job.identityHint,setDates:async()=>job.scope.dates,readDirectory:async()=>({notes:job.notes,scope:job.scope}),goPage:async()=>{},
  diagnoses:async()=>[],loadAudience:async()=>{},official:async(_,name)=>saveArtifact(root,'official/'+name+'.xlsx',excel,{kind:'official'}),
  coreScreenshot:async(_,note,mode)=>screenshot('core-view-trends/'+(mode==='按小时'?'hour':'day')+'/'+(note.artifactName||'N1')+'/full.png',mode),
  trendScreenshot:async()=>[await screenshot('trends/N1/full.png')]};
 const previous={};for(const [k,value] of Object.entries(mocked)){previous[k]=XhsAdapter.prototype[k];XhsAdapter.prototype[k]=value;}
 const oldFlush=ResponseCollector.prototype.flush;ResponseCollector.prototype.flush=async function(){this.records=structuredClone(snapshot.responses);};
 t.after(()=>{Object.assign(XhsAdapter.prototype,previous);ResponseCollector.prototype.flush=oldFlush;});
 const browser=()=>Promise.resolve({channel:'synthetic',page:{goto:async()=>{},isClosed:()=>false,url:()=> 'https://example.invalid/',locator:()=>({innerText:async()=> 'Synthetic account A 发布笔记',filter:()=>({count:async()=>0})})},context:new EventEmitter(),close:async()=>{}});
 let finished=await collect(options,{jobId:'J1'},new AbortController().signal,()=>{},{openBrowser:browser});assert.equal(finished.status,'complete');assert.deepEqual(finished.completed,['N1']);
 finished=await collect(options,{jobId:'J1',retryOnly:true,noteId:'N1'},new AbortController().signal,()=>{},{openBrowser:browser});assert.equal(finished.status,'complete');assert.deepEqual(finished.completed,['N1']);
 result=run(['status','J1']);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).completed,1);
 result=run(['export','J1']);assert.equal(result.status,0,result.stderr);assert.ok(await fs.stat(path.join(root,'J1.zip')));
 const before=await fs.readFile(cfg.databasePath),source=await fs.readFile(path.join(root,'content-data.json')),configBefore=await fs.readFile(config);
 await syncHistory(cfg,{account:'Synthetic'});const repo=await HistoryRepository.open(historyPaths(cfg).database);assert.equal(repo.snapshots().length,1);assert.equal(repo.verify().ok,true);repo.close();
 assert.deepEqual(await fs.readFile(cfg.databasePath),before);assert.deepEqual(await fs.readFile(path.join(root,'content-data.json')),source);assert.deepEqual(await fs.readFile(config),configBefore);
});
