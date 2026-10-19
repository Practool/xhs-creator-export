import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
export async function workspace(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'xhs-history-test-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return {root,outputDir:path.join(root,'jobs'),databasePath:path.join(root,'tasks.sqlite')};}
export function fixture(id='J1',ids=['N1'],views=[100]){
 const time='2026-10-01T02:00:00.000Z';
 const notes=ids.map(id=>({id,title:'合成中文标题',url:'https://example.invalid/'+id}));
 return {schemaVersion:4,job:{schemaVersion:4,id,createdAt:time,updatedAt:time,finishedAt:time,status:'complete',identityHint:'Synthetic account A',
  directoryComplete:true,notes,completed:[...ids],officialFiles:[],exportWarnings:[],errors:[],config:{},programVersion:'0.2.0',scope:{dates:['2026-10-01','2026-10-03'],total:ids.length,pages:1,restriction:'synthetic'}},
  records:ids.map((id,i)=>({row:{'笔记ID':id,'标题':'合成中文标题','内容类型':'视频','发布时间':'2026-09-30 10:00:00','曝光数':200,'观看数':views[i]??0,'点赞数':0,'评论数':0,'收藏数':0,'分享数':0,'封面点击率':26.9},
   snapshot:{capturedAt:time,identityHint:'Synthetic account A',url:'https://example.invalid/'+id,responses:[],diagnoses:[],officialFiles:[],coreViewScreenshots:[],trendScreenshots:[]}}))};
}
export async function writeJob(cfg,data){const dir=path.join(cfg.outputDir,data.job.id);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'content-data.json'),JSON.stringify(data));await fs.writeFile(path.join(dir,'validation.json'),JSON.stringify({schemaVersion:4,jobId:data.job.id,status:data.job.status,complete:data.job.status==='complete',invalidArtifacts:[],warnings:[],errors:[]}));return dir;}
export const hash=data=>createHash('sha256').update(data).digest('hex');
export const source=data=>({jobId:data.job.id,root:'/synthetic/'+data.job.id,archive:data,validation:{},fingerprint:hash(JSON.stringify(data))});
export const metric=(s,key)=>s.metrics.find(m=>m.metric_key===key);

export async function publicRepo(cfg){const repo=path.join(cfg.root,'public-repo');await fs.mkdir(path.join(repo,'docs'),{recursive:true});execFileSync('git',['init','--quiet',repo]);return repo;}
