import {tags,timestamp,retime} from './ingest.js';

// The compressed H.264/AAC bytes are unchanged. Normalize stream DTS only, so
// browser seek positions start at zero instead of the CDN's long-running clock.
export class DouyinFlv {
  constructor(){this.buffer=Buffer.alloc(0);this.header=false;this.origin=null;this.duration=0;this.media=false;}
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
      if(type===9&&(tag[11]&15)!==7||type===8&&tag[11]>>4!==10)throw new Error('该直播暂未提供可剪辑的 H.264/AAC 画质。');
      const header=media&&tag[12]===0;
      if(media&&!header){this.origin??=timestamp(tag);this.media=true;}
      const time=media&&!header?Math.max(0,timestamp(tag)-(this.origin??0)):0;
      this.duration=Math.max(this.duration,time/1000);output.push(retime(tag,time));
    }
    this.buffer=Buffer.from(this.buffer.subarray(parsed.consumed));return output;
  }
  finish(){if(!this.header||!this.media)throw new Error('直播没有返回有效音视频。');}
}
