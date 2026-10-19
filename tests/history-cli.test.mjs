import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';import Database from 'better-sqlite3';
import {fixture,workspace,writeJob} from './helpers.mjs';import {historyPaths,syncHistory} from '../dist/history/sync.js';import {HistoryRepository} from '../dist/history/repository.js';
const cli=path.resolve('dist/cli.js');
export async function writeConfig(cfg){const file=path.join(cfg.root,'config.yaml');await fs.writeFile(file,JSON.stringify({browser:'auto',profileDir:path.join(cfg.root,'profile'),outputDir:cfg.outputDir,databasePath:cfg.databasePath,headless:true,intervalMs:0}));return file;}
const run=(cfg,config,args)=>spawnSync(process.execPath,[cli,'--config',config,...args],{cwd:cfg.root,encoding:'utf8',timeout:20000});

test('WP07 help preserves old commands, adds history help without configuration or browser',()=>{
 for(const args of [['--help'],...['init','doctor','login','collect','status','resume','retry','export'].map(n=>[n,'--help']),['history','--help'],...['sync','status','verify','export'].map(n=>['history',n,'--help'])]) {
  const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/Usage:/);
 }
});
test('WP07 CLI missing account diagnostic, missing history does not initialize, verify, history export, old tasks unchanged',async t=>{
 const cfg=await workspace(t),config=await writeConfig(cfg);await writeJob(cfg,fixture());await fs.writeFile(cfg.databasePath,'synthetic task baseline');const before=await fs.readFile(cfg.databasePath);
 let r=run(cfg,config,['history','status']);assert.equal(r.status,1);assert.match(r.stderr,/HISTORY_MISSING/);
 assert.equal(await fs.stat(historyPaths(cfg).database).then(()=>true).catch(()=>false),false);
 r=run(cfg,config,['history','sync']);assert.equal(r.status,2);assert.match(r.stdout,/ACCOUNT_AMBIGUOUS/);
 r=run(cfg,config,['history','sync','--account','A']);assert.equal(r.status,0,r.stderr);
 r=run(cfg,config,['history','verify']);assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).ok,true);
 r=run(cfg,config,['history','status']);assert.equal(JSON.parse(r.stdout).current_snapshots,1);
 r=run(cfg,config,['history','export','--account','A']);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).snapshots,1);
 assert.deepEqual(await fs.readFile(cfg.databasePath),before);
});
test('WP08/T13 actual SIGINT stops at a committed job boundary, re-run completes without duplication',async t=>{
 const cfg=await workspace(t),config=await writeConfig(cfg);
 for(let i=0;i<45;i++)await writeJob(cfg,fixture('J'+String(i).padStart(3,'0'),Array.from({length:10},(_,n)=>'N'+n),Array(10).fill(100)));
 const child=spawn(process.execPath,[cli,'-c',config,'history','sync','--account','A'],{cwd:cfg.root,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
 let interrupted=false;
 for(let i=0;i<1000 && child.exitCode===null;i++){
  try{const db=new Database(historyPaths(cfg).database,{readonly:true,fileMustExist:true});let n=0;try{n=db.prepare('SELECT COUNT(*) n FROM source_imports').get().n;}finally{db.close();}if(n>0){child.kill('SIGINT');interrupted=true;break;}}catch{}
  await delay(5);
 }
 const result=await exit;assert.equal(interrupted,true,'child completed before interruption');assert.equal(result.code,130,stderr);assert.equal(JSON.parse(stdout).cancelled,true);
 let repo=await HistoryRepository.open(historyPaths(cfg).database);const partial=repo.status().current_snapshots;assert.ok(partial>0&&partial<450);repo.close();
 const report=await syncHistory(cfg,{account:'A'});assert.equal(report.cancelled,false);repo=await HistoryRepository.open(historyPaths(cfg).database);assert.equal(repo.status().current_snapshots,450);assert.equal(repo.verify().ok,true);repo.close();
});
test('WP08/T15 readonly output and future DB version fail nonzero without deleting data',async t=>{
 const cfg=await workspace(t),config=await writeConfig(cfg);await writeJob(cfg,fixture());await syncHistory(cfg,{account:'A'});
 const parent=path.join(cfg.root,'readonly');await fs.mkdir(parent);await fs.chmod(parent,0o500);
 try{let r=run(cfg,config,['history','export','--output',path.join(parent,'new')]);assert.equal(r.status,1);assert.match(r.stderr,/READ_ONLY/);}finally{await fs.chmod(parent,0o700);}
 const db=new Database(historyPaths(cfg).database);db.pragma('user_version=99');db.close();const r=run(cfg,config,['history','status']);assert.equal(r.status,1);assert.match(r.stderr,/DB_VERSION_NEWER/);
 const inspect=new Database(historyPaths(cfg).database);assert.equal(inspect.pragma('user_version',{simple:true}),99);inspect.close();
});
test('WP08 measured synthetic performance (1000 snapshots), no unmeasured performance claim',async t=>{
 const cfg=await workspace(t);for(let i=0;i<20;i++)await writeJob(cfg,fixture('P'+i,Array.from({length:50},(_,n)=>'N'+n),Array(50).fill(100)));
 const start=performance.now();await syncHistory(cfg,{account:'Synthetic'});const elapsed=performance.now()-start;
 const repo=await HistoryRepository.open(historyPaths(cfg).database);assert.equal(repo.status().current_snapshots,1000);repo.close();
 console.log('BENCHMARK synthetic_snapshots=1000 jobs=20 elapsed_ms='+elapsed.toFixed(1));
});
