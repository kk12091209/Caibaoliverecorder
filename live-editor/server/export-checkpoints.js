import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mp4Complete} from './export-publication.js';

const NAME='.bili-export-checkpoint.json',OWNER='.bili-temp-owner.json',FORMAT='bili-export-checkpoint-v1';
const fields=['dev','ino','size','mtimeNs','ctimeNs'];
const identity=s=>Object.fromEntries(fields.map(k=>[k,String(s[k])]));
const same=(s,record)=>fields.every(k=>String(s[k])===record[k]);
const basename=name=>typeof name==='string'&&/^(?:part-\d+(?:-danmaku)?\.mp4|final(?:-danmaku)?\.mp4|audio(?:-\d+)?\.(?:m4a|flac))$/.test(name);
const invalid=()=>new Error('导出恢复记录或文件身份异常，已保留现场；可重新创建导出任务。');
async function ordinary(file){const stat=await fs.lstat(file,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n||stat.size<=0n)throw invalid();return stat;}

// Checkpoints belong to one persisted export and its exact media signature.
// Their workspace uses the existing ownership, process and retention guards.
export class ExportCheckpoints {
  constructor(media){this.media=media;}
  async open(job,signature){
    const m=this.media,old=job.processingRecovery;let directory;
    if(old){
      if(old.version!==1||typeof old.signature!=='string')throw invalid();
      await m.temporaryWorkspaces.adoptRetained(old.directory,job.id);
      if(old.signature===signature)directory=old.directory;
      else await this.discard(job);
    }
    if(!directory){
      directory=await m.temporaryDirectory('bili-export-',job.session);
      await m.temporaryWorkspaces.retain(directory,job.id,{processing:{signature}});
      job.processingRecovery={version:1,directory,signature};
    }
    job.resumeOnLaunch=true;m.persistExportJob(job);
    const owner=JSON.parse(await fs.readFile(path.join(directory,OWNER),'utf8'));
    let records={},lastGood;
    for(const name of [NAME,'.bili-export-checkpoint.previous.json'])try{
      const file=path.join(directory,name),stat=await ordinary(file);if(stat.size>4n*1024n**2n)throw invalid();
      const text=await fs.readFile(file,'utf8'),data=JSON.parse(text);
      if(data.format!==FORMAT||data.jobId!==job.id||data.signature!==signature||data.token!==owner.token||!data.records||typeof data.records!=='object'||Array.isArray(data.records))throw invalid();
      records=data.records;lastGood=text;break;
    }catch(error){
      if(error.code==='EACCES'||error.code==='EPERM')throw error;
      if(error.code!=='ENOENT')job.checkpointWarning='部分处理记录不可用，将使用上一份有效记录核对片段。';
    }
    job.processingRecovery.completedSteps=Object.keys(records).length;
    let writing=Promise.resolve();
    const save=()=>{
      const next=writing.catch(()=>{}).then(async()=>{
        // The owning exporter may checkpoint one finished block while another
        // block's ffprobe still reads this workspace. This is not an adoption.
        const writer=m.temporaryWorkspaces.retainedState(directory,job.id,false);if(writer.completed)throw invalid();
        const write=async(name,text)=>{
          const temporary=path.join(directory,`.bili-export-checkpoint-${randomUUID()}.tmp`);
          try{const handle=await fs.open(temporary,'wx');try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}await fs.rename(temporary,path.join(directory,name));}
          finally{await fs.unlink(temporary).catch(()=>{});}
        };
        const text=JSON.stringify({format:FORMAT,jobId:job.id,signature,token:owner.token,records});
        if(lastGood&&lastGood!==text)await write('.bili-export-checkpoint.previous.json',lastGood);
        await write(NAME,text);lastGood=text;
      });writing=next;return next;
    };
    const checkpoint={directory,resumed:0,async run(key,work,files=[]){
      m.assertExportActive();
      const prior=Object.hasOwn(records,key)?records[key]:null;
      if(prior&&Array.isArray(prior.files)&&prior.files.every(f=>basename(f.name))){
        try{
          const expected=typeof files==='function'?files(prior.result):files;
          if(!Array.isArray(expected)||prior.files.length!==expected.length||!expected.every(name=>prior.files.some(f=>f.name===name)))throw invalid();
          for(const f of prior.files){const file=path.join(directory,f.name),stat=await ordinary(file);if(!same(stat,f))throw invalid();if(f.name.endsWith('.mp4'))await mp4Complete(file,Number(stat.size));}
          checkpoint.resumed++;job.resumedExportSteps=(job.resumedExportSteps||0)+1;return prior.result;
        }catch(error){if(!['ENOENT'].includes(error.code)&&['EACCES','EPERM','EBUSY'].includes(error.code))throw error;}
      }
      const result=await m.retryMedia(work),names=typeof files==='function'?files(result):files;
      const saved=await m.retryMedia(async()=>{const values=[];for(const name of names){
        if(!basename(name))throw invalid();const file=path.join(directory,name),stat=await ordinary(file);
        if(name.endsWith('.mp4'))await mp4Complete(file,Number(stat.size));
        const handle=await fs.open(file,'r+');try{await handle.sync();}finally{await handle.close();}
        values.push({name,...identity(await ordinary(file))});
      }return values;});
      records[key]={files:saved,result:result??null};await m.retryMedia(save);job.processingRecovery.completedSteps=Object.keys(records).length;m.persistExportJob(job);return result;
    },async finish(){await writing.catch(()=>{});await m.temporaryWorkspaces.finish(directory);}};
    await m.retryMedia(save);return checkpoint;
  }
  async discard(job){
    const directory=job.processingRecovery?.directory;if(!directory)return;
    const owner=JSON.parse(await fs.readFile(path.join(directory,OWNER),'utf8'));
    if(owner.retained?.publicationIntent)throw new Error('这份任务还有待保存成片，请先恢复保存。');
    await this.media.temporaryWorkspaces.release(directory,job.id);
    await this.media.temporaryWorkspaces.finish(directory);
    delete job.processingRecovery;
  }
}
