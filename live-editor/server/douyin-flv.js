import {tags,timestamp,retime} from './ingest.js';

// A new clock/codec epoch must start in a new source. Keep the valid prefix so
// the caller can finish it before reconnecting; never clamp a reset to zero.
export class DouyinStreamChange extends Error {
  constructor(message,frames=[]){super(message);this.code='DOUYIN_STREAM_CHANGE';this.frames=frames;}
}
export class DouyinFlv {
  constructor(){this.buffer=Buffer.alloc(0);this.header=false;this.origin=null;this.duration=0;this.media=false;this.last=new Map();this.codecs=new Map();this.videoTime=null;this.stalledBytes=0;}
  feed(chunk) {
    if(this.buffer.length+chunk.length>20*1024*1024)throw new Error('直播数据包过大。');
    this.buffer=this.buffer.length?Buffer.concat([this.buffer,chunk]):Buffer.from(chunk);
    const output=[];
    if(!this.header){
      if(this.buffer.length<13)return output;
      if(this.buffer.toString('ascii',0,3)!=='FLV'||this.buffer.readUInt32BE(5)!==9||this.buffer.readUInt32BE(9)!==0)throw new Error('直播未返回标准 FLV。');
      output.push(Buffer.from(this.buffer.subarray(0,13)));this.buffer=this.buffer.subarray(13);this.header=true;
    }
    const parsed=tags(this.buffer);
    for(const {tag}of parsed.items){
      const type=tag[0],media=type===8||type===9;
      if(type===9&&(tag[11]&15)!==7||type===8&&tag[11]>>4!==10){
        if(this.media)throw new DouyinStreamChange('直播编码发生变化，重新获取兼容画质。',output);
        throw new Error('该直播暂未提供可剪辑的 H.264/AAC 画质。');
      }
      const header=media&&tag[12]===0;
      if(header){
        const body=tag.subarray(11,-4),previous=this.codecs.get(type);
        if(this.media&&previous&&!previous.equals(body))throw new DouyinStreamChange('直播编码参数发生变化，安全分段后重连。',output);
        this.codecs.set(type,Buffer.from(body));
      }
      if(type===9&&tag[12]===2&&this.media)throw new DouyinStreamChange('当前视频流已结束，重新核对直播状态。',output);
      let time=0;
      if(media&&!header){
        const raw=timestamp(tag),previous=this.last.get(type);
        // Audio/video interleave independently; small encoder jitter is allowed.
        // Check before retiming, so bad timestamps never enter the saved source.
        if(previous!==undefined&&(raw<previous-1000||raw>previous+15000)||this.origin!==null&&raw<this.origin-1000)
          throw new DouyinStreamChange('直播时间戳发生跳变，安全分段后重连。',output);
        const first=!this.media,previousDuration=this.duration;
        this.origin??=raw;this.media=true;this.last.set(type,Math.max(previous??raw,raw));
        time=Math.max(0,raw-this.origin);this.duration=Math.max(this.duration,time/1000);
        this.stalledBytes=first||this.duration>previousDuration?0:this.stalledBytes+tag.length;
        if(this.stalledBytes>16*1024*1024)throw new DouyinStreamChange('收到大量重复时间戳数据，保留有效内容后重连。',output);
        if(type===9)this.videoTime=Math.max(this.videoTime??0,time);
      }
      output.push(retime(tag,time));
    }
    this.buffer=Buffer.from(this.buffer.subarray(parsed.consumed));return output;
  }
  finish(){if(!this.header||!this.media)throw new Error('直播没有返回有效音视频。');}
}
