import fs from 'node:fs/promises';
import path from 'node:path';

export const pathKey=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
export function inside(root,file) {const relative=path.relative(pathKey(root),pathKey(file));return !!relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
export function fingerprint(stat) {return JSON.stringify(Object.fromEntries(['dev','ino','size','mtimeNs','ctimeNs'].map(name=>[name,String(stat[name])])));}
export async function checkedFile(root,file,{directory=false,missing=false}={}) {
  if(typeof file!=='string'||!path.isAbsolute(file)||!inside(root,file))throw new Error('素材路径不在本项目管理目录内，已保留过渡片段。');
  const absolute=path.resolve(file),volume=path.parse(absolute).root;let current=volume,stat;
  for(const part of path.relative(volume,absolute).split(path.sep)) {
    current=path.join(current,part);
    try{stat=await fs.lstat(current,{bigint:true});}catch(error){if(missing&&error.code==='ENOENT')return null;throw error;}
    if(stat.isSymbolicLink())throw new Error('素材路径含符号链接或目录联接，已保留过渡片段。');
    if(pathKey(current)!==pathKey(absolute)&&!stat.isDirectory())throw new Error('素材父级路径异常，已保留过渡片段。');
  }
  if(pathKey(await fs.realpath(absolute))!==pathKey(absolute)||(directory?!stat.isDirectory():!stat.isFile()))throw new Error('素材实际路径或类型已改变，已保留过渡片段。');
  return stat;
}

// Sequential bounded reads preserve exact original tag bytes and absolute
// offsets. No process is spawned and no original recording is modified.
export async function* originalTags(handle,start=13,{signal,checkpoint}={}) {
  let position=start,buffer=Buffer.alloc(0),bufferOffset=start;
  while(!signal?.aborted) {
    const next=Buffer.allocUnsafe(1024*1024),{bytesRead}=await handle.read(next,0,next.length,position);
    if(!bytesRead){if(buffer.length)throw new Error('完整原片末尾存在截断数据，已保留过渡片段。');return;}
    position+=bytesRead;buffer=buffer.length?Buffer.concat([buffer,next.subarray(0,bytesRead)]):next.subarray(0,bytesRead);
    let consumed=0;
    while(consumed+15<=buffer.length) {
      const length=buffer.readUIntBE(consumed+1,3)+15;
      if(length>16*1024*1024)throw new Error('原片 FLV 数据包大小异常。');
      if(consumed+length>buffer.length)break;
      if(buffer.readUInt32BE(consumed+length-4)!==length-4)throw new Error('原片 FLV 数据包边界校验失败。');
      if(signal?.aborted)return;
      yield {tag:buffer.subarray(consumed,consumed+length),offset:bufferOffset+consumed};consumed+=length;
    }
    buffer=Buffer.from(buffer.subarray(consumed));bufferOffset+=consumed;
    await checkpoint?.(bytesRead);
  }
}
export const isMedia=tag=>tag[0]===8||tag[0]===9;
export const isCodecHeader=tag=>(tag[0]===9||tag[11]>>4===10)&&tag[12]===0;
export const isKeyframe=tag=>tag[0]===9&&tag.length>16&&tag[12]===1&&tag[11]>>4===1;

const leases=new WeakMap();
export function acquireReader(store,sourceId) {
  const source=store.get('SELECT session FROM sources WHERE id=?',sourceId);
  if(!source||store.deletions?.has(source.session))throw new Error('素材正在删除，无法继续读取。');
  let map=leases.get(store);if(!map)leases.set(store,map=new Map());
  const storage=store.get('SELECT * FROM source_storage WHERE source=?',sourceId),mode=storage?.mode==='direct'?'direct':'chunks';
  const key=sourceId+':'+mode;map.set(key,(map.get(key)||0)+1);let released=false;
  return {mode,storage,release(){if(released)return;released=true;const count=map.get(key)||0;if(count<=1)map.delete(key);else map.set(key,count-1);}};
}
export const chunkReaderCount=(store,id)=>leases.get(store)?.get(id+':chunks')||0;
export const sourceReaderCount=(store,id)=>chunkReaderCount(store,id)+(leases.get(store)?.get(id+':direct')||0);
