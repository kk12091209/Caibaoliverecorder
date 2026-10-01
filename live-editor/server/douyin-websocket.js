import https from 'node:https';
import {createHash,randomBytes} from 'node:crypto';

export const MAX_WS_BYTES=8*1024*1024;
// RFC 6455 framing, without compression extensions. Douyin compresses the
// protobuf payload itself. No dependency or browser cookie store is required.
export class WebSocketFrames {
  constructor({message,ping=()=>{},close=()=>{},maximum=MAX_WS_BYTES}) {
    Object.assign(this,{message,ping,close,maximum});this.buffer=Buffer.alloc(0);
    this.parts=[];this.bytes=0;this.opcode=0;this.ended=false;
  }
  feed(chunk) {
    if(this.ended)return;
    if(this.buffer.length+chunk.length>this.maximum+65536)throw new Error('弹幕连接数据过大。');
    this.buffer=this.buffer.length?Buffer.concat([this.buffer,chunk]):chunk;
    let offset=0;
    while(offset+2<=this.buffer.length) {
      const first=this.buffer[offset],second=this.buffer[offset+1],opcode=first&15,fin=!!(first&128);
      if(first&112||second&128)throw new Error('弹幕连接帧无效。');
      let length=second&127,header=2;
      if(length===126){if(offset+4>this.buffer.length)break;length=this.buffer.readUInt16BE(offset+2);header=4;}
      else if(length===127){if(offset+10>this.buffer.length)break;const big=this.buffer.readBigUInt64BE(offset+2);if(big>BigInt(this.maximum))throw new Error('弹幕连接数据过大。');length=Number(big);header=10;}
      if(length>this.maximum||opcode>=8&&(!fin||length>125))throw new Error('弹幕连接帧过大。');
      if(offset+header+length>this.buffer.length)break;
      const data=this.buffer.subarray(offset+header,offset+header+length);offset+=header+length;
      if(opcode===8){if(length===1)throw new Error('弹幕关闭帧无效。');this.ended=true;this.close(length>=2?data.readUInt16BE(0):1005);break;}
      if(opcode===9){this.ping(data);continue;}if(opcode===10)continue;
      if(opcode===0){if(!this.opcode)throw new Error('弹幕分片顺序无效。');}
      else if(opcode===1||opcode===2){if(this.opcode)throw new Error('弹幕分片重叠。');this.opcode=opcode;}
      else throw new Error('弹幕帧类型无效。');
      this.bytes+=length;
      if(this.bytes>this.maximum||this.parts.length>=1024)throw new Error('弹幕分片过大。');
      // A fragment owns only its payload, not the complete incoming socket chunk.
      this.parts.push(Buffer.from(data));
      if(fin){const payload=this.parts.length===1?this.parts[0]:Buffer.concat(this.parts,this.bytes),type=this.opcode;this.parts=[];this.bytes=0;this.opcode=0;if(type===2)this.message(payload);}
    }
    this.buffer=offset===this.buffer.length?Buffer.alloc(0):Buffer.from(this.buffer.subarray(offset));
  }
}

export function clientFrame(payload,opcode=2) {
  payload=Buffer.from(payload);if(payload.length>MAX_WS_BYTES)throw new Error('弹幕发送数据过大。');
  const length=payload.length,header=length<126?2:length<=65535?4:10;
  const output=Buffer.allocUnsafe(header+4+length);output[0]=128|opcode;
  if(header===2)output[1]=128|length;
  else if(header===4){output[1]=128|126;output.writeUInt16BE(length,2);}
  else{output[1]=128|127;output.writeBigUInt64BE(BigInt(length),2);}
  const mask=randomBytes(4);mask.copy(output,header);
  for(let i=0;i<length;i++)output[header+4+i]=payload[i]^mask[i&3];
  return output;
}

export function openDouyinSocket(url,{headers={},signal,onMessage,onClose=()=>{}}) {
  url=new URL(url);
  if(url.protocol!=='wss:'||!/^webcast[\w-]*\.douyin\.com$/.test(url.hostname)||url.port||url.username||url.password)throw new Error('弹幕服务器地址无效。');
  return new Promise((resolve,reject)=>{
    let socket,settled=false,ended=false;const key=randomBytes(16).toString('base64');
    const expected=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const request=https.request(url.href.replace(/^wss:/,'https:'),{method:'GET',headers:{...headers,Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':key}});
    const finish=error=>{if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket?.destroy();request.destroy();if(!settled){settled=true;reject(error||new Error('弹幕连接已关闭。'));}else onClose(error);};
    const abort=()=>finish(signal?.reason instanceof Error?signal.reason:new Error('弹幕连接已停止。'));
    const timer=setTimeout(()=>finish(new Error('弹幕连接超时。')),15000);
    if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
    request.on('error',finish);
    request.on('response',response=>{response.destroy();finish(new Error(`弹幕连接失败：${response.statusCode}`));});
    request.on('upgrade',(response,stream,head)=>{
      socket=stream;
      if(response.statusCode!==101||response.headers['sec-websocket-accept']!==expected||response.headers['sec-websocket-extensions']){finish(new Error('弹幕握手校验失败。'));return;}
      const send=(data,opcode=2)=>{if(ended||!socket.writable)return false;if(socket.writableLength>65536){finish(new Error('弹幕连接发送受阻。'));return false;}return socket.write(clientFrame(data,opcode));};
      const parser=new WebSocketFrames({message:onMessage,ping:data=>send(data,10),close:code=>finish(new Error(`弹幕连接被关闭：${code}`))});
      socket.on('data',data=>{try{parser.feed(data);}catch(error){finish(error);}});
      socket.on('error',finish);socket.on('end',()=>finish());socket.on('close',()=>finish());
      clearTimeout(timer);settled=true;resolve({send,close:()=>finish(),get closed(){return ended;}});
      if(head.length){try{parser.feed(head);}catch(error){finish(error);}}
    });
    request.end();
  });
}
