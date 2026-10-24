import fs from 'node:fs/promises';
import path from 'node:path';
import {sourceStream,timestamp} from './ingest.js';

const unsafe=message=>Object.assign(new Error(message),{code:'AUDIO_COPY_UNSAFE'});
const rates=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];

// Only AAC-LC with a known 1024-sample frame is eligible for packet copying.
function aacConfiguration(tag){
  if(tag.length<19||tag[11]>>4!==10||tag[12]!==0)throw unsafe('缺少可验证的 AAC 配置。');
  const a=tag[13],b=tag[14],rate=rates[((a&7)<<1)|(b>>7)],channels=(b>>3)&15;
  if(a>>3!==2||!rate||![1,2].includes(channels)||(b&7)!==0)throw unsafe('当前 AAC 配置需要常规音频处理。');
  return {rate,channels,signature:tag.subarray(13,-4).toString('hex')};
}

// Export audio never needs to send video packets through FFmpeg's input pipe.
// Own the small audio buffers so they do not retain large backing video chunks.
export async function* audioSourceStream(store,source,from,to,{signal,wholeSource=false,verify,stats={}}={}){
  let header=true,configuration,first,count=0,queued=[],bytes=0;
  for await(const buffer of sourceStream(store,source.id,from,to,{signal,wholeSource})){
    if(header){const value=Buffer.from(buffer);value[4]=4;yield value;header=false;continue;}
    for(let offset=0;offset<buffer.length;){
      const length=11+buffer.readUIntBE(offset+1,3)+4;
      if(length<15||offset+length>buffer.length)throw new Error('音频来源数据包不完整。');
      const tag=buffer.subarray(offset,offset+length);offset+=length;
      if(tag[0]!==8)continue;
      if(verify){
        if(tag[11]>>4!==10)throw unsafe('音频编码发生变化。');
        if(tag[12]===0){
          const next=aacConfiguration(tag);
          if(configuration&&configuration.signature!==next.signature)throw unsafe('AAC 配置发生变化。');
          configuration=next;Object.assign(stats,next);
        }else{
          if(tag[12]!==1||!configuration)throw unsafe('AAC 数据包无法验证。');
          const time=timestamp(tag)/1000;
          if(time>=verify.duration)continue;
          first??=time;
          if(verify.joined&&first>.002)throw unsafe('重连处有前置静音，需要精确拼接。');
          if(Math.abs(time-(first+count*1024/configuration.rate))>.002)throw unsafe('AAC 时间戳存在空缺或跳变。');
          count++;Object.assign(stats,{first,count,end:first+count*1024/configuration.rate});
        }
      }
      const owned=Buffer.from(tag);queued.push(owned);bytes+=owned.length;
      if(bytes>=64*1024){yield Buffer.concat(queued,bytes);queued=[];bytes=0;}
    }
  }
  if(verify&&(!count||Math.abs(stats.end-verify.duration)>1024/stats.rate+.002))throw unsafe('音频尾部需要精确补齐。');
  if(bytes)yield Buffer.concat(queued,bytes);
}

export async function copyFullAudio(media,sourcePlan,fps,workDir){
  if(!sourcePlan?.canCopyStreams||!sourcePlan.entries.every(e=>e.info.audioStreams===1&&e.info.audioCodec==='aac'))return null;
  const parts=[],statsList=[];let duration=0,configuration;
  for(let index=0;index<sourcePlan.entries.length;index++){
    media.assertExportActive?.();
    const entry=sourcePlan.entries[index],span=(Math.round(entry.to*fps)-Math.round(entry.from*fps))/fps;
    const file=sourcePlan.entries.length===1?'audio.m4a':`audio-copy-${index}.m4a`,stats={};
    await media.process(['-copyts','-f','flv','-i','pipe:0','-map','0:a:0','-vn','-t',String(span),'-c:a','copy','-movflags','+faststart','-y',file],
      {cwd:workDir,stage:'audio',input:audioSourceStream(media.store,entry.source,entry.from,entry.to,
        {wholeSource:entry.wholeFromSource,stats,verify:{duration:span,joined:sourcePlan.entries.length>1}})});
    if(configuration&&configuration!==stats.signature)throw unsafe('不同来源的 AAC 配置不兼容。');configuration=stats.signature;
    const info=await media.probeAudio(path.join(workDir,file));
    if(info.codec_name!=='aac'||!Number.isFinite(Number(info.start_time))||Number(info.sample_rate)!==stats.rate||Number(info.channels)!==stats.channels||
      Number(info.nb_frames)!==stats.count||Math.abs(Number(info.start_time)-stats.first)>.002)throw unsafe('复制后的音轨信息不一致。');
    duration+=span;parts.push({file,duration:span});statsList.push(stats);
  }
  if(parts.length>1){
    const samples=statsList.reduce((sum,s)=>sum+s.count*1024,0),rate=statsList[0].rate;
    if(Math.abs(samples/rate-duration)>1024/rate+.002)throw unsafe('多段 AAC 拼接的累计时长需要精确校正。');
    await fs.writeFile(path.join(workDir,'audio-copy-concat.txt'),'ffconcat version 1.0\n'+parts.map(p=>`file '${p.file}'\ninpoint 0\nduration ${p.duration}`).join('\n'));
    await media.process(['-copyts','-f','concat','-safe','1','-i','audio-copy-concat.txt','-map','0:a:0','-c:a','copy','-t',String(duration),'-movflags','+faststart','-y','audio.m4a'],{cwd:workDir,stage:'audio'});
    const info=await media.probeAudio(path.join(workDir,'audio.m4a'));
    if(!Number.isFinite(Number(info.duration))||!Number.isFinite(Number(info.start_time))||Number(info.nb_frames)!==statsList.reduce((sum,s)=>sum+s.count,0)||Math.abs(Number(info.duration)-duration)>1024/rate+.002||Math.abs(Number(info.start_time))>.002)throw unsafe('拼接后的音轨时长不一致。');
  }
  return 'audio.m4a';
}
